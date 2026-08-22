import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { MESSAGES_PAGE_LIMIT, MESSAGES_PAGE_OLDER_LIMIT } from '@shared/lib/messages-page'
import type { PendingMessage } from './pending-message'

// On very long threads we render only a trailing window of messages to keep the
// DOM small. Sessions with <= BASE_WINDOW visible items render in full, so small
// and medium threads are completely unaffected. Scrolling near the top reveals
// LOAD_STEP more at a time. The window is a fixed-size tail slice, so while new
// messages stream in at the bottom the oldest rendered ones drop off the top and
// the DOM node count stays flat. The window only grows on an explicit scroll-up
// and is reset when the session changes.
const BASE_WINDOW = MESSAGES_PAGE_LIMIT
const LOAD_STEP = MESSAGES_PAGE_OLDER_LIMIT
const TURN_ANCHOR_TOP = 100
// Live-edge following (engage/escape/resume and the smooth chase) is owned by
// use-stick-to-bottom: it derives escape from user-attributable signals (wheel
// direction, scroll direction, text selection) and drives the viewport from
// content resizes — scroll-event echoes of its own writes can never disengage
// it. The layer in this file only manages what sits on top of that: the
// new-turn reading-line reserve (the spacer) and windowed history loading.
//
// Scroll events cannot say who caused them, so the reserve adjustments below
// only act on events that closely follow a real gesture (wheel/touch/keys, or
// a held-down pointer for scrollbar drags). A layout clamp from shrinking
// content carries no fresh gesture and passes through untouched.
const SCROLL_GESTURE_WINDOW_MS = 400
// A press only becomes a drag (and thereby a scroll gesture) once the pointer
// travels this far from where it went down.
const POINTER_DRAG_THRESHOLD_PX = 4
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '])
const UPWARD_SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

// Mirrors the browser's scroll chaining for wheel input: a nested scrollable
// consumes the wheel while it can still move in that direction; only at its
// edge does the event scroll the ancestor.
function nestedScrollableConsumesWheel(el: HTMLElement, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight) return false
  const { overflowY } = getComputedStyle(el)
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false
  if (deltaY < 0) return el.scrollTop > 0
  if (deltaY > 0) return el.scrollTop < el.scrollHeight - el.clientHeight - 1
  return false
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

interface MessageListScrollOptions<T> {
  /** Messages after visibility filtering — what the trailing window slices. */
  visibleMessages: readonly T[]
  /** A new non-queued ghost anchors its turn's reading line (`data-turn-anchor-id`). */
  pendingUserMessages: PendingMessage[] | undefined
  /** Growth means a work phase collapsed into a summary row — a guarded transition. */
  completedTurnCount: number
  /** Height of an overlaid footer that the live edge must remain above. */
  bottomInset: number
  /** Older-history paging, driven by scrolling near the top. */
  hasOlder: boolean
  isFetchingOlder: boolean
  fetchOlder: ((onBeforePrepend?: () => void) => Promise<boolean>) | undefined
  /** The scroll container mounts only after these resolve — observers re-attach on them. */
  isLoading: boolean
  error: unknown
  /**
   * Never read — effect dependencies only. Each marks a commit that can change
   * transcript layout, after which the turn reserve must re-sync.
   */
  messages: unknown
  streamingMessage: unknown
  streamingToolUses: unknown
  thinkingBlocks: unknown
  isCompacting: unknown
  pendingRequestCount: unknown
  activeSubagents: unknown
}

/**
 * All scrolling behavior for the message list: live-edge following (via
 * use-stick-to-bottom plus the gesture-attribution layer that keeps its
 * position-inferred escapes honest), the new-turn reading-line reserve, and
 * the windowed rendering of long histories with scroll-anchored older-page
 * loading. The component renders; this hook decides where the viewport is.
 *
 * The returned handlers must all be bound on the scroll container, and the
 * four refs on their respective elements (see MessageList's JSX). Turn-starting
 * ghost wrappers must carry `data-turn-anchor-id={localId}` for the
 * reading-line anchor to find them.
 */
export function useMessageListScroll<T>(options: MessageListScrollOptions<T>) {
  const {
    visibleMessages,
    pendingUserMessages,
    completedTurnCount,
    bottomInset,
    hasOlder,
    isFetchingOlder,
    fetchOlder,
    isLoading,
    error,
    messages,
    streamingMessage,
    streamingToolUses,
    thinkingBlocks,
    isCompacting,
    pendingRequestCount,
    activeSubagents,
  } = options

  // Live-edge following. `isAtBottom` goes false only on a user-attributable
  // escape (wheel up, upward scroll, selection drag) and comes back when the
  // reader returns near the bottom — geometry sampled from our own writes can
  // never disengage it. Content growth is followed from the library's
  // ResizeObserver on `contentRef`, so the bottom inset below must be a real
  // element (content-box), not container padding.
  const {
    scrollRef,
    contentRef,
    scrollToBottom: stickScrollToBottom,
    stopScroll: stickStopScroll,
    isAtBottom,
    state: stickState,
  } = useStickToBottom({
    initial: 'instant',
    ...(prefersReducedMotion() ? { resize: 'instant' as const } : {}),
  })
  const contentBodyRef = useRef<HTMLDivElement>(null)
  const bottomSpacerRef = useRef<HTMLDivElement>(null)
  const bottomSpacerHeightRef = useRef(0)
  const anchoredTurnRef = useRef<{ localId: string; scrollTop: number } | null>(null)
  const lastScrollTopRef = useRef(0)
  const lastGestureAtRef = useRef(0)
  // Stamped only by gestures that can justify LEAVING the live edge: wheel-up
  // reaching this scroller, touch, upward scroll keys, an actual drag. A
  // downward wheel or a bare click stamps lastGestureAtRef but never this —
  // otherwise a browser clamp landing near such input reads as the user
  // scrolling away and kills following (idle trackpad noise near a thinking
  // card collapse was enough).
  const lastEscapeIntentAtRef = useRef(0)
  // Stamped when a gesture-attributed scroll event moved the reader upward
  // AND escape intent backs it — used to honor escapes the transition shield
  // swallowed.
  const lastUpwardGestureAtRef = useRef(0)
  const pointerDownRef = useRef(false)
  const pointerDownAtRef = useRef(0)
  // A press only becomes a scroll gesture once the pointer moves (a scrollbar
  // drag); a motionless press — or one whose release was swallowed by a native
  // context menu or a focus change — must not gesture-attribute scroll events
  // indefinitely.
  const pointerDragRef = useRef(false)
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null)
  // True from a send until its scroll-to-reading-line settles. The library
  // only assigns state.animation in its first animation frame, so this is the
  // signal that covers the whole interval (a commit landing between the send
  // effect and that first frame would otherwise let the reserve restore
  // preempt the glide with an instant jump).
  const sendScrollInFlightRef = useRef(false)

  // How many trailing (visible) messages to render. Grows on scroll-up and while
  // the user is scrolled up during streaming. Starts at BASE_WINDOW; the component
  // is keyed by sessionId at its mount site, so a switched session remounts fresh.
  const [windowSize, setWindowSize] = useState(BASE_WINDOW)
  // Scroll height captured just before a scroll-up expansion, used to re-anchor the
  // viewport after the larger slice renders so the content under the user doesn't jump.
  const prevScrollHeightRef = useRef<number | null>(null)

  // The trailing slice we actually render. Derived values in the component still
  // compute over the FULL message list, so turn boundaries / elapsed times / etc.
  // stay correct even when their anchor message is outside the rendered window.
  const windowedMessages = useMemo(
    () => visibleMessages.slice(-windowSize),
    [visibleMessages, windowSize]
  )
  const hiddenCount = visibleMessages.length - windowedMessages.length

  // Keep the rendered range anchored at the top while the user is scrolled up.
  // The window is a trailing slice, so when new messages are persisted it would
  // normally drop the same number off the top — shifting the content the user is
  // reading (overflow-anchor is disabled, so nothing compensates). Growing the
  // window by exactly that delta keeps the same first rendered item; the new
  // messages just append below, off-screen. When pinned to the bottom we leave the
  // window alone so the slice slides and the DOM stays bounded.
  const prevVisibleLenRef = useRef(visibleMessages.length)
  useLayoutEffect(() => {
    const grown = visibleMessages.length - prevVisibleLenRef.current
    prevVisibleLenRef.current = visibleMessages.length
    // Grow while the reader is away from the live edge (escaped), during the
    // new-turn reserve, or when an older-page prepend is landing (a pending
    // scroll capture marks that) — so the rows the user is reading keep their
    // position instead of sliding off the trailing window.
    if (
      grown > 0 &&
      (!stickState.isAtBottom || anchoredTurnRef.current || prevScrollHeightRef.current != null)
    ) {
      setWindowSize((n) => n + grown)
    }
  }, [visibleMessages, stickState])

  const setBottomSpacerHeight = useCallback((height: number) => {
    const spacer = bottomSpacerRef.current
    if (!spacer) return
    const nextHeight = Math.max(0, Math.ceil(height))
    bottomSpacerHeightRef.current = nextHeight
    spacer.style.height = `${nextHeight}px`
    spacer.hidden = nextHeight === 0
  }, [])

  // A programmatic follow transition — the send-anchor scroll (where the
  // previous turn collapses to a summary row and content shrinks above), or a
  // viewport re-pin — can coincide with a browser clamp whose scroll event
  // reads as the reader scrolling up. Two defenses: shield the library's
  // deferred classification across the transition (it skips scroll events
  // while a resize is in flight), and verify shortly after — an escape with
  // no user gesture inside the window can only be such an echo, so reverse
  // it. Real gestures (wheel, touch, held pointer, scroll keys) suppress the
  // reversal, so a reader who actually leaves during the window stays left.
  const verifyFollowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(verifyFollowTimerRef.current), [])
  // Verify shortly after a transition — or after a gesture-driven scroll —
  // that following's engagement still matches what the user actually did.
  // `intentBacked` marks an arming scroll produced by a live escape intent:
  // any latch it caused is genuine and must not be reversed.
  const armFollowVerification = useCallback((intentBacked: boolean) => {
    const transitionAt = performance.now()
    // Only a disengage that HAPPENS inside this window is suspect. A reader
    // who left the live edge long ago and then scrolls (even downward) must
    // never be yanked back — reversal applies solely to follows that were
    // still engaged when the window opened.
    const wasFollowing = stickState.isAtBottom
    clearTimeout(verifyFollowTimerRef.current)
    verifyFollowTimerRef.current = setTimeout(() => {
      // A disengage inside the window with nothing to justify it can only be
      // a clamp echo or a follow-write misread as an upward scroll — reverse
      // it. An active drag, escape intent inside the window, or a press
      // around the transition (a scrollbar track click pages without moving
      // the pointer) all say the reader may genuinely own their position.
      const userMayOwnPosition =
        intentBacked ||
        (pointerDownRef.current && pointerDragRef.current) ||
        lastEscapeIntentAtRef.current >= transitionAt ||
        (pointerDownRef.current &&
          pointerDownAtRef.current >= transitionAt - SCROLL_GESTURE_WINDOW_MS)
      if (!userMayOwnPosition && wasFollowing && !stickState.isAtBottom) {
        void stickScrollToBottom(prefersReducedMotion() ? 'instant' : undefined)
        return
      }
      // The shield cuts both ways: while it holds, the library also discards
      // the scroll classification of genuine keyboard, touch, and scrollbar
      // escapes (wheel-up escapes through its own handler and is unaffected).
      // If an intent-backed gesture moved the reader upward during the window
      // yet following still reads engaged and they are beyond the re-stick
      // range, that escape was swallowed — honor it, or the next growth would
      // yank them back down. Reserve eating is unaffected: it re-bases the
      // reading line onto the reader, keeping them within the re-stick range.
      if (
        stickState.isAtBottom &&
        lastUpwardGestureAtRef.current >= transitionAt &&
        !stickState.isNearBottom
      ) {
        stickStopScroll()
      }
    }, 40)
  }, [stickState, stickScrollToBottom, stickStopScroll])
  const protectFollowTransition = useCallback(() => {
    if (stickState.resizeDifference === 0) {
      stickState.resizeDifference = 1
      // Mirror the library's own reset: the clamp's deferred classification
      // (a tick after its scroll event) must land inside the shield, so drop
      // it a frame + a tick later. The guard keeps a concurrent real content
      // resize's value intact.
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (stickState.resizeDifference === 1) stickState.resizeDifference = 0
        }, 1)
      })
    }
    armFollowVerification(false)
  }, [stickState, armFollowVerification])

  // Keep the newly-sent turn fixed at its reading line while the response uses
  // up the reserved room below it. The spacer inflates scrollHeight so that the
  // reading line IS the scroll target: from the follow library's perspective
  // the reader simply sits at the bottom, and content growth paired with an
  // equal spacer shrink is a net-zero resize — no motion. Once the reserve
  // reaches zero the anchor retires and real growth resumes normal following.
  const syncTurnReserve = useCallback(() => {
    const el = scrollRef.current
    const anchoredTurn = anchoredTurnRef.current
    if (!el || !anchoredTurn) return
    const naturalScrollHeight = el.scrollHeight - bottomSpacerHeightRef.current
    const requiredSpacer = Math.max(
      0,
      anchoredTurn.scrollTop + el.clientHeight - naturalScrollHeight,
    )
    setBottomSpacerHeight(requiredSpacer)
    // The response now fills the viewport. Retire the special turn state so
    // long-thread windowing can return to its bounded trailing slice.
    if (requiredSpacer === 0) {
      anchoredTurnRef.current = null
      return
    }
    // A transient content shrink during the reserve hold (a working indicator
    // swapping forms, a streamed block replaced by its shorter persisted copy)
    // clamps scrollTop below the reading line for the instant before the
    // spacer write above re-inflates the scroll range — and nothing else moves
    // it back until content grows again, so the held turn visibly sags. The
    // anchored reading line IS the scroll target while the reserve holds, so
    // put the viewport back on it. Skip while the reader is gesturing (their
    // scroll owns the position — reserve eating re-bases the anchor), while a
    // send's scroll to the reading line is pending or animating (it starts
    // below the target by construction), and while any other scroll
    // animation is in flight.
    const gestureDriven =
      (pointerDownRef.current && pointerDragRef.current) ||
      performance.now() - lastGestureAtRef.current < SCROLL_GESTURE_WINDOW_MS
    const target = Math.max(0, stickState.calculatedTargetScrollTop)
    if (
      !sendScrollInFlightRef.current &&
      !gestureDriven &&
      stickState.isAtBottom &&
      !stickState.animation &&
      el.scrollTop < target
    ) {
      protectFollowTransition()
      stickState.scrollTop = target
      lastScrollTopRef.current = el.scrollTop
    }
  }, [scrollRef, setBottomSpacerHeight, stickState, protectFollowTransition])

  // Pin the viewport to the live edge before first paint. The library's own
  // initial scroll runs from its ResizeObserver callback, which lands after
  // paint — without this, opening a session flashes the top of the transcript
  // for a frame. Guarded and dep-free because the scroll container mounts only
  // after loading/error states resolve.
  const pinnedInitialRef = useRef(false)
  useLayoutEffect(() => {
    if (pinnedInitialRef.current || !scrollRef.current) return
    pinnedInitialRef.current = true
    stickState.scrollTop = Math.max(0, stickState.calculatedTargetScrollTop)
    lastScrollTopRef.current = scrollRef.current.scrollTop
  })

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const previousScrollTop = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop

    // Only scroll events that closely follow a real gesture may adjust the
    // reserve. Programmatic writes (the follow animation) and layout clamps
    // from shrinking content reach this handler too, but carry no fresh
    // wheel/touch/key stamp and no moving drag, so they pass through. A held
    // pointer counts only while it is an actual drag — a stale press (its
    // release swallowed by a context menu or a focus change) must not keep
    // attributing clamps to the user indefinitely.
    const now = performance.now()
    const activeDrag = pointerDownRef.current && pointerDragRef.current
    const gestureDriven =
      activeDrag || now - lastGestureAtRef.current < SCROLL_GESTURE_WINDOW_MS
    const escapeIntentLive =
      activeDrag || now - lastEscapeIntentAtRef.current < SCROLL_GESTURE_WINDOW_MS

    // A gesture-driven scroll can be misread by the follow library as an
    // upward escape even when the input pointed down (its follow writes and
    // the native scroll fight over scrollTop, and the loser's position reads
    // as "scrolled up"). Re-verify shortly after every gesture-driven scroll
    // so a latch with no escape intent behind it gets reversed. Armed before
    // the upward stamp below so that stamp postdates the verification window.
    if (gestureDriven) armFollowVerification(escapeIntentLive)

    // Blank reserve is one-way. When the reader moves upward, consume the same
    // number of pixels from the spacer. The new scroll position becomes the
    // reserve's live edge, so that discarded blank area cannot be revisited.
    const anchoredTurn = anchoredTurnRef.current
    const upwardDelta = Math.max(0, previousScrollTop - el.scrollTop)
    const downwardDelta = Math.max(0, el.scrollTop - previousScrollTop)
    if (gestureDriven && upwardDelta > 0 && escapeIntentLive) {
      lastUpwardGestureAtRef.current = performance.now()
    }
    if (gestureDriven && anchoredTurn && upwardDelta > 0 && bottomSpacerHeightRef.current > 0) {
      const discard = Math.min(upwardDelta, bottomSpacerHeightRef.current)
      const remainingSpacer = bottomSpacerHeightRef.current - discard
      anchoredTurn.scrollTop = Math.max(0, anchoredTurn.scrollTop - discard)
      setBottomSpacerHeight(remainingSpacer)
      if (remainingSpacer === 0) anchoredTurnRef.current = null
    }

    // Reaching the actual live edge through a user scroll is an explicit trip
    // to the bottom: retire the reserve so its blank room doesn't keep the
    // streamed content away from the reader. The browser clamps scrollTop to
    // the new natural maximum synchronously.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (
      gestureDriven &&
      downwardDelta > 0 &&
      anchoredTurnRef.current &&
      distanceFromBottom <= 1
    ) {
      anchoredTurnRef.current = null
      setBottomSpacerHeight(0)
      lastScrollTopRef.current = el.scrollTop
    }

    // Near the top: reveal the next local chunk, or fetch the next API page.
    // prevScrollHeightRef is only set when we know the DOM will grow (local
    // expand, or fetchOlder about to prepend) so a failed/empty fetch cannot wedge.
    if (el.scrollTop < 200 && prevScrollHeightRef.current == null) {
      if (hiddenCount > 0) {
        prevScrollHeightRef.current = el.scrollHeight
        setWindowSize((n) => n + LOAD_STEP)
      } else if (hasOlder && !isFetchingOlder && fetchOlder) {
        void fetchOlder(() => {
          // Back at the bottom mid-fetch: the trailing window doesn't move on
          // prepend, so skip the capture — a lingering guard would block the
          // next scroll-up gesture. Derived from geometry at capture time.
          const viewport = scrollRef.current
          if (
            viewport &&
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 100
          ) {
            prevScrollHeightRef.current = viewport.scrollHeight
          }
        })
      }
    }
  }, [hiddenCount, hasOlder, isFetchingOlder, fetchOlder, setBottomSpacerHeight, scrollRef, armFollowVerification])

  // After a scroll-up expansion adds older messages above the viewport, restore the
  // scroll position so the content the user was reading stays put (no jump).
  // Deps are [windowSize] ONLY: when a prepend lands the anchor effect grows
  // windowSize in the same commit, so this fires exactly when the rows mount.
  // A visibleMessages.length dep would consume the guard one commit early
  // (data grows, window unchanged, delta 0) and leave the mount uncompensated.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && prevScrollHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current
      prevScrollHeightRef.current = null
    }
    // scrollRef is a stable library ref — windowSize remains the sole trigger.
  }, [windowSize, scrollRef])

  const scrollToBottom = useCallback(() => {
    // Drop the turn reserve first so the scroll target is the true live edge,
    // not the blank reading-line reserve.
    anchoredTurnRef.current = null
    setBottomSpacerHeight(0)
    void stickScrollToBottom(prefersReducedMotion() ? 'instant' : undefined)
  }, [setBottomSpacerHeight, stickScrollToBottom])

  // A turn completing collapses its whole work phase into a summary row — a
  // massive one-commit shrink whose browser clamp reads as the reader
  // scrolling up, stranding the viewport above the final answer. Guard the
  // transition from the same commit (this runs before the clamp's scroll
  // event can dispatch, so the shield is race-free here).
  const prevCompletedTurnCountRef = useRef(completedTurnCount)
  useLayoutEffect(() => {
    const grew = completedTurnCount > prevCompletedTurnCountRef.current
    prevCompletedTurnCountRef.current = completedTurnCount
    if (grew && stickState.isAtBottom) protectFollowTransition()
  }, [completedTurnCount, stickState, protectFollowTransition])

  // Detect actual sends by id (rather than list length, since materialization
  // can remove one ghost as another arrives). A turn-starting send gets a
  // stable reading line 100px from the viewport top; queued mid-turn sends
  // retain the regular live-edge behavior.
  const seenPendingIdsRef = useRef(new Set<string>())
  useLayoutEffect(() => {
    const seen = seenPendingIdsRef.current
    let hasNewSend = false
    let newestTurnStart: PendingMessage | undefined
    for (const pending of pendingUserMessages ?? []) {
      if (!seen.has(pending.localId)) {
        seen.add(pending.localId)
        hasNewSend = true
        if (!pending.queued) newestTurnStart = pending
      }
    }

    if (hasNewSend) {
      if (newestTurnStart) {
        const viewport = scrollRef.current
        const anchor = Array.from(
          contentBodyRef.current?.querySelectorAll<HTMLElement>('[data-turn-anchor-id]') ?? [],
        ).find((element) => element.dataset.turnAnchorId === newestTurnStart.localId)

        if (viewport && anchor) {
          lastScrollTopRef.current = viewport.scrollTop
          const anchorTop =
            anchor.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop
          anchoredTurnRef.current = {
            localId: newestTurnStart.localId,
            scrollTop: Math.max(0, anchorTop - TURN_ANCHOR_TOP),
          }
        } else {
          anchoredTurnRef.current = null
          setBottomSpacerHeight(0)
        }
      } else {
        anchoredTurnRef.current = null
        setBottomSpacerHeight(0)
      }

      // The viewport intentionally sits below the new reading line until the
      // scroll below travels there — hold the reserve restore off for the
      // whole interval (state.animation alone starts too late: the library
      // assigns it in its first animation frame, and a commit can land first).
      sendScrollInFlightRef.current = true
      // Size the reserve before scrolling so the scroll target IS the new
      // turn's reading line (the spacer inflates scrollHeight to end there).
      syncTurnReserve()
      // The collapse of the finished turn above (same commit as the ghost)
      // shrinks content and can clamp scrollTop — guard the transition so
      // that clamp echo cannot latch an escape under the send.
      protectFollowTransition()
      // A send always returns the reader to the thread: re-engage following
      // and glide to the reading line (or the live edge for queued sends).
      // Under reduced motion, position synchronously instead of gliding.
      if (prefersReducedMotion()) {
        stickState.scrollTop = Math.max(0, stickState.calculatedTargetScrollTop)
      }
      void Promise.resolve(
        stickScrollToBottom(prefersReducedMotion() ? 'instant' : undefined),
      ).finally(() => {
        sendScrollInFlightRef.current = false
      })
      // Programmatic writes fire their scroll event asynchronously (and not at
      // all in jsdom) — resync the gesture-delta baseline now so the write
      // isn't misread as a user delta.
      lastScrollTopRef.current = scrollRef.current?.scrollTop ?? 0
      return
    }

    syncTurnReserve()
  }, [
    messages,
    pendingUserMessages,
    streamingMessage,
    streamingToolUses,
    thinkingBlocks,
    isCompacting,
    pendingRequestCount,
    activeSubagents,
    syncTurnReserve,
    setBottomSpacerHeight,
    scrollRef,
    stickState,
    stickScrollToBottom,
    protectFollowTransition,
    bottomInset,
  ])

  // Markdown, images, and expanded tool cards can change height without a
  // message-state update. Feed those layout changes through the same reserve
  // calculation so they cannot make the anchored turn jump. Re-attach after
  // the loading/error states resolve — the scroll container mounts only then.
  useEffect(() => {
    const content = contentBodyRef.current
    const viewport = scrollRef.current
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return
    let frameId = 0
    let lastViewportHeight = viewport.clientHeight
    let lastContentHeight = content.offsetHeight
    const observer = new ResizeObserver(() => {
      // A vertical viewport resize is invisible to the follow library (it
      // observes only the content element), and browsers anchor the TOP edge
      // on resize — so a window shrink would slide the live edge behind the
      // fold. Re-pin immediately while following, guarded against the grow
      // clamp's scroll echo being read as an escape (a viewport GROW lowers
      // the scroll range, and the browser's clamp fires a scroll event that
      // classifies as the reader scrolling up). During the turn reserve the
      // spacer math already keeps the reading line valid, so no pin there.
      const viewportHeight = viewport.clientHeight
      if (viewportHeight !== lastViewportHeight) {
        lastViewportHeight = viewportHeight
        if (stickState.isAtBottom && !anchoredTurnRef.current) {
          protectFollowTransition()
          stickState.scrollTop = Math.max(0, stickState.calculatedTargetScrollTop)
          lastScrollTopRef.current = viewport.scrollTop
        }
      }
      // Catch-all for content shrinks at the live edge (a thinking card
      // collapsing, a streamed block swapped for its shorter persisted form):
      // each one clamps scrollTop and can latch a spurious escape the same
      // way. The commit-hooked guards cover the big known transitions
      // race-free; this covers the rest via the deferred verification.
      const contentHeight = content.offsetHeight
      if (contentHeight < lastContentHeight && stickState.isAtBottom) {
        protectFollowTransition()
      }
      lastContentHeight = contentHeight
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(syncTurnReserve)
    })
    observer.observe(content)
    observer.observe(viewport)
    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [syncTurnReserve, scrollRef, stickState, protectFollowTransition, isLoading, error])

  // Escape from following is owned by the stick-to-bottom library (wheel
  // direction, scroll direction, selection). These stamps exist so the scroll
  // handler can attribute reserve adjustments to a live gesture, and so the
  // deferred verification can tell escape-capable input (wheel-up, touch,
  // upward keys, a drag) from input that never leaves the live edge.
  // A wheel consumed by a nested scrollable (the thinking card's body, a code
  // block) never moves the transcript and must not count as a transcript
  // gesture; scroll chaining hands the wheel to us only once the inner
  // scroller is at its edge, which the walk below mirrors.
  const handleWheelGesture = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const outer = scrollRef.current
    if (!outer) return
    let node = event.target as HTMLElement | null
    while (node && node !== outer) {
      if (nestedScrollableConsumesWheel(node, event.deltaY)) return
      node = node.parentElement
    }
    const now = performance.now()
    lastGestureAtRef.current = now
    if (event.deltaY < 0) lastEscapeIntentAtRef.current = now
  }, [scrollRef])

  // Touch direction isn't knowable from a single event without tracking touch
  // points; treat any touch scroll as escape-capable.
  const handleTouchGesture = useCallback(() => {
    const now = performance.now()
    lastGestureAtRef.current = now
    lastEscapeIntentAtRef.current = now
  }, [])

  // Scrollbar interactions emit no wheel/touch/key events — track the held
  // pointer. Only a pointer that actually moves is a drag; a motionless press
  // (or one whose release never arrived) must not stay a gesture forever.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    pointerDownRef.current = true
    pointerDragRef.current = false
    pointerDownAtRef.current = performance.now()
    pointerDownPosRef.current = { x: event.clientX, y: event.clientY }
    lastGestureAtRef.current = performance.now()
  }, [])
  useEffect(() => {
    const release = () => {
      pointerDownRef.current = false
      pointerDragRef.current = false
      pointerDownPosRef.current = null
    }
    const move = (event: PointerEvent) => {
      if (!pointerDownRef.current) return
      if (!pointerDragRef.current) {
        const start = pointerDownPosRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) <
          POINTER_DRAG_THRESHOLD_PX
        ) {
          return
        }
        pointerDragRef.current = true
      }
      const now = performance.now()
      lastGestureAtRef.current = now
      lastEscapeIntentAtRef.current = now
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('pointermove', move)
    // A native context menu (two-finger tap) or a focus change can swallow the
    // pointerup — without these, the "held pointer" would outlive the gesture
    // indefinitely and every later browser clamp would read as user scrolling.
    window.addEventListener('blur', release)
    window.addEventListener('contextmenu', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('blur', release)
      window.removeEventListener('contextmenu', release)
    }
  }, [])

  const handleScrollKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!SCROLL_KEYS.has(event.key)) return
    const now = performance.now()
    lastGestureAtRef.current = now
    const upward =
      UPWARD_SCROLL_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)
    if (upward) lastEscapeIntentAtRef.current = now
  }, [])

  return {
    scrollRef,
    contentRef,
    contentBodyRef,
    bottomSpacerRef,
    isAtBottom,
    scrollToBottom,
    windowedMessages,
    hiddenCount,
    handleScroll,
    handleWheelGesture,
    handleTouchGesture,
    handlePointerDown,
    handleScrollKey,
  }
}
