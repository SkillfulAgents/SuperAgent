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

// ---------------------------------------------------------------------------
// The follow engine.
//
// Scroll events carry no provenance — the browser does not say whether a
// scroll came from the user, from our own write, or from a layout clamp. The
// engine never guesses from position deltas alone. Instead:
//
//   - ESCAPE is input-primary: an upward wheel that reaches this scroller, an
//     upward scroll key, or a drag disengages following the moment the input
//     arrives — before any scroll event, so a concurrent follow write can
//     never swallow it.
//   - The BACKSTOP for inputs with no distinct event (a dragged scrollbar,
//     touch momentum) classifies a scroll event as the user's only when the
//     geometry was stable AND some input recently touched the scroller: our
//     own writes always update the baseline in the same statement, a browser
//     clamp only ever fires in a frame where scrollHeight or clientHeight
//     changed, and WebKit's async scrolling can roll a write back with no
//     input at all — upward + stable + fresh input is the reader leaving;
//     upward + stable + no input is the engine, and following converges back.
//   - FOLLOWING is convergent: while engaged, every content or viewport
//     resize re-pins the live edge with a single instant write. A missed or
//     misread event can cost one frame, never a dead latch.
//   - Programmatic motion is minimal: instant writes everywhere, and one
//     owned glide (an exponential chase, cancelled by any user input) for the
//     explicit trips — send and the scroll-to-bottom affordance.
// ---------------------------------------------------------------------------

// The live-edge target keeps a 1px allowance: at fractional zoom levels
// scrollTop is non-integer and an exact-maximum target never quite settles.
const LIVE_EDGE_ALLOWANCE_PX = 1
// A user scroll arriving within this of the bottom re-engages following. Kept
// generous on purpose: while a response streams the end is a moving target,
// so a reader chasing it always lands short of exact.
const ATTACH_OFFSET_PX = 70
// The backstop only reads an upward stable-geometry move as an escape once it
// leaves this band. Elastic overscroll bounce-back (Safari) and sub-pixel
// jitter land inside it; a real escape leaves it in one gesture.
const ESCAPE_MIN_DISTANCE_PX = 24
// The backstop additionally requires some input to have touched the scroller
// this recently before it releases following. WebKit's async scrolling can
// roll a programmatic write back to its last composited position and report
// that as a genuine upward, size-stable scroll event — with no input
// anywhere near it, that shape is the engine's, not the reader's, and
// following converges back instead of disengaging (reproduced by
// safari-follow.spec.ts: zero-input rollbacks to the same committed position
// after large thinking-card collapses, WebKit only).
const INPUT_EVIDENCE_WINDOW_MS = 500
// How long the scrolling tree gets to settle before convergence re-pins
// after an engine-caused upward scroll.
const ENGINE_SCROLL_SETTLE_MS = 150
// After a user-attributed upward scroll, hold re-pins briefly so an in-flight
// upward gesture (wheel ticks eating the reserve) isn't fought mid-motion.
const USER_SCROLL_HOLD_MS = 100
// The glide's exponential approach rate (per second) and its hard stop.
const GLIDE_RATE_PER_S = 14
const GLIDE_MAX_MS = 1500

const UPWARD_SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])
// A press only becomes a drag once the pointer travels this far from where it
// went down.
const POINTER_DRAG_THRESHOLD_PX = 4
// Touch momentum keeps scrolling after the last touch event; the interaction
// only ends once scroll events go quiet for this long.
const TOUCH_SETTLE_MS = 150

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

const liveEdgeTarget = (el: HTMLElement) =>
  Math.max(0, el.scrollHeight - LIVE_EDGE_ALLOWANCE_PX - el.clientHeight)

const distanceFromBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight

interface ScrollSample {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

interface MessageListScrollOptions<T> {
  /** Messages after visibility filtering — what the trailing window slices. */
  visibleMessages: readonly T[]
  /** A new non-queued ghost anchors its turn's reading line (`data-turn-anchor-id`). */
  pendingUserMessages: PendingMessage[] | undefined
  /** Overlaid-footer height. Only re-syncs the reserve on change — the inset element itself is rendered by the caller. */
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
 * All scrolling behavior for the message list: live-edge following (the owned
 * engine above), the new-turn reading-line reserve, and the windowed rendering
 * of long histories with scroll-anchored older-page loading. The component
 * renders; this hook decides where the viewport is.
 *
 * The returned handlers must all be bound on the scroll container, and the
 * four refs on their respective elements (see MessageList's JSX). Turn-starting
 * ghost wrappers must carry `data-turn-anchor-id={localId}` for the
 * reading-line anchor to find them. The container must keep
 * `overflow-anchor: none` — the browser's own scroll anchoring is otherwise a
 * third scrollTop writer the engine cannot attribute.
 */
export function useMessageListScroll<T>(options: MessageListScrollOptions<T>) {
  const {
    visibleMessages,
    pendingUserMessages,
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

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const contentBodyRef = useRef<HTMLDivElement>(null)
  const bottomSpacerRef = useRef<HTMLDivElement>(null)
  const bottomSpacerHeightRef = useRef(0)
  const anchoredTurnRef = useRef<{ localId: string; scrollTop: number } | null>(null)

  // Following state lives in a ref (the single source of truth — handlers and
  // observers read it without stale-closure risk); the state mirror only
  // drives the scroll-to-bottom affordance's rendering.
  const followingRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)
  // The last known geometry, updated by every scroll event AND by every write
  // the engine makes. A scroll event is classified against it: same
  // scrollHeight and clientHeight means no clamp or resize is in flight, so a
  // position change the baseline doesn't already reflect came from the user.
  const baselineRef = useRef<ScrollSample | null>(null)
  const lastUserScrollUpAtRef = useRef(0)

  // Interaction tracking. A drag (a press that moved), a press on the
  // scrollbar gutter (track clicks page without pointer motion), and an
  // active touch sequence each suspend pinning — the user owns the viewport
  // for the duration, and following is re-derived from where they end up.
  const pointerDownRef = useRef(false)
  const pointerDragRef = useRef(false)
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null)
  const pointerOnScrollbarRef = useRef(false)
  // Any input that reached the scroller — wheel (either direction), scroll
  // key, pointer press, touch. The backstop's release requires this to be
  // fresh; see INPUT_EVIDENCE_WINDOW_MS.
  const lastInputAtRef = useRef(0)
  const touchActiveRef = useRef(false)
  const touchSettleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleTouchSettleRef = useRef<(() => void) | null>(null)

  // The one owned animation: an exponential chase toward the (live,
  // re-computed each frame) target, used only for explicit trips. Its first
  // write is deferred a frame so a commit landing between the send effect and
  // the glide's start still sees the pre-glide viewport.
  const glideRef = useRef<{ cancel: () => void } | null>(null)

  // How many trailing (visible) messages to render. Grows on scroll-up and while
  // the user is scrolled up during streaming. Starts at BASE_WINDOW; the component
  // is keyed by sessionId at its mount site, so a switched session remounts fresh.
  const [windowSize, setWindowSize] = useState(BASE_WINDOW)
  // Scroll height captured just before a scroll-up expansion, used to re-anchor the
  // viewport after the larger slice renders so the content under the user doesn't jump.
  const prevScrollHeightRef = useRef<number | null>(null)

  const rememberPosition = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    baselineRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
  }, [])

  const cancelGlide = useCallback(() => {
    glideRef.current?.cancel()
  }, [])

  const releaseFollow = useCallback(() => {
    followingRef.current = false
    setIsAtBottom(false)
    glideRef.current?.cancel()
  }, [])

  // While a held pointer is growing a text selection inside the transcript,
  // pinning would drag the selection anchor away mid-gesture.
  const selectionInProgress = useCallback(() => {
    if (!pointerDownRef.current) return false
    const selection = window.getSelection()
    return (
      !!selection &&
      !selection.isCollapsed &&
      !!selection.anchorNode &&
      !!scrollRef.current?.contains(selection.anchorNode)
    )
  }, [])

  // Re-assert the live edge. Convergence, not classification: called after
  // every content/viewport resize and every reserve sync while following, so
  // any clamp or missed event self-heals on the next change. Skipped while
  // the user owns the viewport (drag/scrollbar/touch/selection — their
  // interaction's end re-derives and pins) and while a glide is making the
  // trip. A fresh upward gesture still in motion also defers the pin — but
  // with a scheduled retry, since the growth that requested it may have been
  // the last one.
  const pinRetryRef = useRef<() => void>(() => {})
  const pinRetryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(pinRetryTimerRef.current), [])
  const pinToLiveEdge = useCallback(() => {
    const el = scrollRef.current
    if (!el || !followingRef.current) return
    if (glideRef.current) return
    if (pointerDragRef.current || pointerOnScrollbarRef.current || touchActiveRef.current) return
    const sinceUserScrollUp = performance.now() - lastUserScrollUpAtRef.current
    if (sinceUserScrollUp < USER_SCROLL_HOLD_MS) {
      clearTimeout(pinRetryTimerRef.current)
      pinRetryTimerRef.current = setTimeout(
        () => pinRetryRef.current(),
        USER_SCROLL_HOLD_MS - sinceUserScrollUp + 10,
      )
      return
    }
    if (selectionInProgress()) return
    const target = liveEdgeTarget(el)
    if (el.scrollTop < target) {
      el.scrollTop = target
      rememberPosition()
    }
  }, [rememberPosition, selectionInProgress])
  useLayoutEffect(() => {
    pinRetryRef.current = pinToLiveEdge
  }, [pinToLiveEdge])

  const glideToLiveEdge = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    glideRef.current?.cancel()
    if (prefersReducedMotion()) {
      el.scrollTop = liveEdgeTarget(el)
      rememberPosition()
      return
    }
    let frameId = 0
    let last = 0
    let startedAt = 0
    const handle = {
      cancel: () => {
        cancelAnimationFrame(frameId)
        if (glideRef.current === handle) glideRef.current = null
      },
    }
    glideRef.current = handle
    const step = (now: number) => {
      if (glideRef.current !== handle) return
      if (!startedAt) {
        startedAt = now
        last = now
      }
      // The target is re-read every frame: content streaming in during the
      // glide moves the live edge, and the chase follows it rather than
      // landing short at a stale coordinate.
      const target = liveEdgeTarget(el)
      const dt = Math.min(64, now - last)
      last = now
      const remaining = target - el.scrollTop
      if (Math.abs(remaining) <= 1 || now - startedAt >= GLIDE_MAX_MS) {
        el.scrollTop = target
        rememberPosition()
        glideRef.current = null
        return
      }
      el.scrollTop = el.scrollTop + remaining * (1 - Math.exp((-dt / 1000) * GLIDE_RATE_PER_S))
      rememberPosition()
      frameId = requestAnimationFrame(step)
    }
    frameId = requestAnimationFrame(step)
  }, [rememberPosition])

  const engageFollow = useCallback((trip: 'instant' | 'glide') => {
    followingRef.current = true
    setIsAtBottom(true)
    if (trip === 'glide') {
      glideToLiveEdge()
      return
    }
    glideRef.current?.cancel()
    const el = scrollRef.current
    if (el) {
      el.scrollTop = liveEdgeTarget(el)
      rememberPosition()
    }
  }, [glideToLiveEdge, rememberPosition])

  // Visible messages the trailing window slices. Derived values in the
  // component still compute over the FULL message list, so turn boundaries /
  // elapsed times / etc. stay correct even when their anchor message is
  // outside the rendered window.
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
      (!followingRef.current || anchoredTurnRef.current || prevScrollHeightRef.current != null)
    ) {
      setWindowSize((n) => n + grown)
    }
  }, [visibleMessages])

  const setBottomSpacerHeight = useCallback((height: number) => {
    const spacer = bottomSpacerRef.current
    if (!spacer) return
    const nextHeight = Math.max(0, Math.ceil(height))
    bottomSpacerHeightRef.current = nextHeight
    spacer.style.height = `${nextHeight}px`
    spacer.hidden = nextHeight === 0
  }, [])

  // Keep the newly-sent turn fixed at its reading line while the response uses
  // up the reserved room below it. The spacer inflates scrollHeight so that the
  // reading line IS the live-edge target: from the engine's perspective the
  // reader simply sits at the bottom, and content growth paired with an equal
  // spacer shrink is a net-zero resize — no motion. Once the reserve reaches
  // zero the anchor retires and real growth resumes normal following.
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
    // it back until content grows again, so the held turn would visibly sag.
    // The anchored reading line IS the live-edge target while the reserve
    // holds; the pin puts the viewport back on it (and carries its own
    // guards for gestures and the send glide).
    pinToLiveEdge()
  }, [setBottomSpacerHeight, pinToLiveEdge])

  // Pin the viewport to the live edge before first paint — without this,
  // opening a session flashes the top of the transcript for a frame. Guarded
  // and dep-free because the scroll container mounts only after loading/error
  // states resolve.
  const pinnedInitialRef = useRef(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (pinnedInitialRef.current || !el) return
    pinnedInitialRef.current = true
    el.scrollTop = liveEdgeTarget(el)
    rememberPosition()
  })

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const baseline = baselineRef.current

    // Upward classification requires stable geometry. Our own writes refresh
    // the baseline in the same statement, so their echoes read as zero
    // deltas; a layout clamp only fires in a frame where the scroll range
    // changed, so it fails the stability check. What remains — an upward
    // move with both dimensions unchanged — has no author but the user (a
    // dragged scrollbar, touch momentum, find-in-page). Downward needs no
    // stability gate at all: clamps only ever DECREASE scrollTop, so an
    // increase the baseline doesn't already reflect is always the user.
    const sizeStable =
      !!baseline &&
      baseline.scrollHeight === el.scrollHeight &&
      baseline.clientHeight === el.clientHeight
    const upwardDelta = sizeStable ? Math.max(0, baseline.scrollTop - el.scrollTop) : 0
    const downwardDelta = baseline ? Math.max(0, el.scrollTop - baseline.scrollTop) : 0

    if (upwardDelta > 0) {
      // Stable geometry narrows the author to the user or the engine itself
      // (WebKit's compositor rolling back a programmatic write). Fresh input
      // is what separates them.
      const inputBacked =
        pointerDownRef.current ||
        touchActiveRef.current ||
        performance.now() - lastInputAtRef.current < INPUT_EVIDENCE_WINDOW_MS
      if (inputBacked) {
        lastUserScrollUpAtRef.current = performance.now()
        // Blank reserve is one-way. When the reader moves upward, consume the
        // same number of pixels from the spacer. The new scroll position
        // becomes the reserve's live edge, so that discarded blank area cannot
        // be revisited — and the re-based target keeps the reader "at the
        // bottom", so eating never disengages following by itself.
        const anchoredTurn = anchoredTurnRef.current
        if (anchoredTurn && bottomSpacerHeightRef.current > 0) {
          const discard = Math.min(upwardDelta, bottomSpacerHeightRef.current)
          const remainingSpacer = bottomSpacerHeightRef.current - discard
          anchoredTurn.scrollTop = Math.max(0, anchoredTurn.scrollTop - discard)
          setBottomSpacerHeight(remainingSpacer)
          if (remainingSpacer === 0) anchoredTurnRef.current = null
        }
      }
      // Beyond the live-edge band, an input-backed upward move is an escape.
      // The band absorbs elastic bounce-back and sub-pixel jitter; wheel and
      // keyboard escapes don't come through here at all (their input events
      // release directly). Without input evidence the move is the engine's:
      // keep following, give the scrolling tree a beat to settle, and
      // converge back to the live edge.
      if (followingRef.current && distanceFromBottom(el) > ESCAPE_MIN_DISTANCE_PX) {
        if (inputBacked) {
          releaseFollow()
        } else {
          clearTimeout(pinRetryTimerRef.current)
          pinRetryTimerRef.current = setTimeout(
            () => pinRetryRef.current(),
            ENGINE_SCROLL_SETTLE_MS,
          )
        }
      }
    }

    if (downwardDelta > 0) {
      // Reaching the actual live edge through a user scroll is an explicit
      // trip to the bottom: retire the reserve so its blank room doesn't
      // keep the streamed content away from the reader.
      if (anchoredTurnRef.current && distanceFromBottom(el) <= 1) {
        anchoredTurnRef.current = null
        setBottomSpacerHeight(0)
      }
      // Arriving near the live edge re-engages following.
      if (!followingRef.current && distanceFromBottom(el) <= ATTACH_OFFSET_PX) {
        engageFollow('instant')
      }
    }

    // Touch momentum is still delivering scroll events — push the settle
    // deadline out; the interaction ends when they go quiet.
    if (touchActiveRef.current && touchSettleTimerRef.current !== undefined) {
      scheduleTouchSettleRef.current?.()
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

    // Re-read rather than reuse the entry sample: reserve eating above may
    // have changed the spacer (and with it scrollHeight) inside this handler.
    rememberPosition()
  }, [hiddenCount, hasOlder, isFetchingOlder, fetchOlder, setBottomSpacerHeight, releaseFollow, engageFollow, rememberPosition])

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
      rememberPosition()
    }
  }, [windowSize, rememberPosition])

  const scrollToBottom = useCallback(() => {
    // Drop the turn reserve first so the trip's target is the true live edge,
    // not the blank reading-line reserve.
    anchoredTurnRef.current = null
    setBottomSpacerHeight(0)
    engageFollow('glide')
  }, [setBottomSpacerHeight, engageFollow])

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

      // A send always returns the reader to the thread: re-engage following
      // and travel to the new turn's reading line (the spacer inflates
      // scrollHeight so the live-edge target IS that line). Order differs by
      // mode: the instant write needs the spacer sized first, while the
      // glide must claim the viewport before the reserve sync — its pin
      // would otherwise jump the trip's starting point.
      if (prefersReducedMotion()) {
        syncTurnReserve()
        engageFollow('instant')
      } else {
        engageFollow('glide')
        syncTurnReserve()
      }
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
    engageFollow,
    bottomInset,
  ])

  // The engine's convergence driver: any content or viewport resize re-pins
  // the live edge while following. This covers streamed growth, thinking-card
  // collapses (the clamp's echo fails the stability check; the pin puts the
  // viewport back), vertical window resizes (browsers anchor the TOP edge, so
  // a shrink would slide the live edge behind the fold), and container-only
  // resizes (a growing composer). Re-attach after the loading/error states
  // resolve — the scroll container mounts only then.
  useEffect(() => {
    const content = contentRef.current
    const viewport = scrollRef.current
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      pinToLiveEdge()
    })
    observer.observe(content)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [pinToLiveEdge, isLoading, error])

  // Markdown, images, and expanded tool cards can change height without a
  // message-state update — and the spacer math depends on the viewport's
  // clientHeight, so window resizes matter too. Feed both through the same
  // reserve calculation so they cannot make the anchored turn jump.
  useEffect(() => {
    const content = contentBodyRef.current
    const viewport = scrollRef.current
    if (!content || !viewport || typeof ResizeObserver === 'undefined') return
    let frameId = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(syncTurnReserve)
    })
    observer.observe(content)
    observer.observe(viewport)
    return () => {
      cancelAnimationFrame(frameId)
      observer.disconnect()
    }
  }, [syncTurnReserve, isLoading, error])

  // --- Input handlers: where escape and re-engage actually come from. -------

  // A wheel consumed by a nested scrollable (the thinking card's body, a code
  // block) never moves the transcript and must not count; scroll chaining
  // hands the wheel to us only once the inner scroller is at its edge, which
  // the walk below mirrors. An upward wheel releases following before its
  // scroll event can be fought over — unless the reserve is holding, where
  // upward motion eats the spacer instead (the scroll handler re-bases the
  // reading line onto the reader). A downward wheel that will land within the
  // attach range re-engages.
  const handleWheelGesture = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const outer = scrollRef.current
    if (!outer) return
    let node = event.target as HTMLElement | null
    while (node && node !== outer) {
      if (nestedScrollableConsumesWheel(node, event.deltaY)) return
      node = node.parentElement
    }
    lastInputAtRef.current = performance.now()
    if (event.deltaY < 0) {
      cancelGlide()
      if (outer.scrollHeight <= outer.clientHeight + 1) return
      if (anchoredTurnRef.current && bottomSpacerHeightRef.current > 0) return
      if (followingRef.current) releaseFollow()
    } else if (event.deltaY > 0 && !followingRef.current) {
      if (distanceFromBottom(outer) - event.deltaY <= ATTACH_OFFSET_PX) {
        engageFollow('instant')
      }
    }
  }, [cancelGlide, releaseFollow, engageFollow])

  const handleScrollKey = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el || el.scrollHeight <= el.clientHeight + 1) return
    lastInputAtRef.current = performance.now()
    const upward =
      UPWARD_SCROLL_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)
    if (upward) {
      cancelGlide()
      if (anchoredTurnRef.current && bottomSpacerHeightRef.current > 0) return
      if (followingRef.current) releaseFollow()
    } else if (event.key === 'End' && !followingRef.current) {
      engageFollow('instant')
    }
  }, [cancelGlide, releaseFollow, engageFollow])

  // When a drag / scrollbar interaction / touch sequence ends, following is
  // derived from where it left the reader — near the live edge means follow.
  const settleInteraction = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (distanceFromBottom(el) <= ATTACH_OFFSET_PX) {
      if (!followingRef.current) engageFollow('instant')
      else pinToLiveEdge()
    } else if (followingRef.current) {
      releaseFollow()
    }
  }, [engageFollow, pinToLiveEdge, releaseFollow])

  // Scrollbar interactions emit no wheel/key events — track the held pointer.
  // A press in the scrollbar gutter suspends pinning outright (track clicks
  // page without any pointer motion); a content press only counts once it
  // actually drags. A motionless press — or one whose release was swallowed
  // by a native context menu or a focus change — must never own the viewport
  // indefinitely.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const el = scrollRef.current
    pointerDownRef.current = true
    pointerDragRef.current = false
    pointerDownPosRef.current = { x: event.clientX, y: event.clientY }
    lastInputAtRef.current = performance.now()
    pointerOnScrollbarRef.current =
      !!el &&
      el.clientWidth > 0 &&
      event.clientX >= el.getBoundingClientRect().left + el.clientWidth
    if (pointerOnScrollbarRef.current) cancelGlide()
  }, [cancelGlide])
  useEffect(() => {
    const release = () => {
      const owned = pointerDragRef.current || pointerOnScrollbarRef.current
      pointerDownRef.current = false
      pointerDragRef.current = false
      pointerDownPosRef.current = null
      pointerOnScrollbarRef.current = false
      if (owned) settleInteraction()
    }
    const move = (event: PointerEvent) => {
      if (!pointerDownRef.current || pointerDragRef.current) return
      const start = pointerDownPosRef.current
      if (!start) return
      if (
        Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) <
        POINTER_DRAG_THRESHOLD_PX
      ) {
        return
      }
      pointerDragRef.current = true
      glideRef.current?.cancel()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('pointermove', move)
    // A native context menu (two-finger tap) or a focus change can swallow the
    // pointerup — without these, the "held pointer" would own the viewport
    // forever and pinning would never resume.
    window.addEventListener('blur', release)
    window.addEventListener('contextmenu', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('blur', release)
      window.removeEventListener('contextmenu', release)
    }
  }, [settleInteraction])

  // Touch: the pan suspends pinning; momentum keeps delivering scroll events
  // after the fingers lift, so the interaction ends only once those go quiet.
  // Escapes still latch mid-gesture through the scroll handler's backstop.
  useEffect(() => {
    scheduleTouchSettleRef.current = () => {
      clearTimeout(touchSettleTimerRef.current)
      touchSettleTimerRef.current = setTimeout(() => {
        touchSettleTimerRef.current = undefined
        touchActiveRef.current = false
        settleInteraction()
      }, TOUCH_SETTLE_MS)
    }
    return () => clearTimeout(touchSettleTimerRef.current)
  }, [settleInteraction])
  const handleTouchStart = useCallback(() => {
    touchActiveRef.current = true
    lastInputAtRef.current = performance.now()
    clearTimeout(touchSettleTimerRef.current)
    touchSettleTimerRef.current = undefined
    cancelGlide()
  }, [cancelGlide])
  const handleTouchMove = useCallback(() => {
    touchActiveRef.current = true
    lastInputAtRef.current = performance.now()
  }, [])
  const handleTouchEnd = useCallback(() => {
    if (!touchActiveRef.current) return
    scheduleTouchSettleRef.current?.()
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
    handlePointerDown,
    handleScrollKey,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  }
}
