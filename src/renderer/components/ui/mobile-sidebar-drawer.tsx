import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "@shared/lib/utils"

/**
 * Finger-following mobile nav drawer. Replaces the Radix `Sheet` on the mobile
 * branch of `Sidebar` so the panel can be *progressively revealed* under the finger
 * instead of only animating open/closed on tap.
 *
 * Gestures (touch only — mouse/desktop is unaffected, and the whole component is
 * only mounted in the `isMobile` branch):
 *  - Swipe in from the left screen edge (≤ `EDGE_ZONE` px) to open. A document-level
 *    `touchstart` listener detects the edge — NOT a physical grab-strip div.
 *  - Drag the open panel left to close it.
 *  - On release: settle open if dragged past `OPEN_THRESHOLD` of the width OR flicked
 *    fast; otherwise snap back. A CSS transition (disabled during the drag) springs it
 *    to the settled end.
 *
 * Owning the left edge means fighting the OS left-edge swipe-back gesture (iOS Safari
 * + installed PWA — where there's otherwise no back affordance, but the nav here is
 * the escape hatch). We suppress it by making the edge `touchstart` NON-passive and
 * `preventDefault`-ing touches that begin in the edge zone. We skip that only when the
 * touch lands on a real control, so taps near the edge still fire — a horizontal drag
 * that starts on a control is still caught in `handleMove`.
 *
 * It's a controlled component — `open`/`onOpenChange` map to the sidebar's existing
 * `openMobile`/`setOpenMobile`, so the trigger button and the close-on-navigation
 * effect keep working unchanged. Taking props (rather than reading the sidebar
 * context) also avoids a circular import with `sidebar.tsx` and keeps it testable.
 *
 * Radix `Sheet` gave a few things for free that we re-implement here: backdrop
 * click-to-close, Esc-to-close, focus-in-on-open / focus-restore-on-close, a Tab
 * focus trap, and hiding the closed panel from the tab order + assistive tech
 * (`inert`). Body scroll-lock is covered by the backdrop capturing all background
 * touches while open (the app shell itself never document-scrolls).
 *
 * iOS status-bar tint (device-proven): in the installed PWA the webview is full-bleed
 * under a translucent status bar, and iOS tints that bar by SAMPLING the colour of the
 * webview's top edge — not from `theme-color`. (Under `black-translucent`,
 * `env(safe-area-inset-top)` reports the real inset, which is what pads content down; it
 * does NOT drive the tint.) So whatever paints at `top:0` becomes the status-bar
 * colour: normally the app gray, but a dark overlay at `top:0` darkens it (and it sticks,
 * because the backdrop stays mounted). Fix: the backdrop's dark FADES IN below the
 * status-bar zone (`BACKDROP_SCRIM`) rather than starting at the top edge — the sampled
 * top row stays the app gray, the dim eases in with no hard seam, and no opaque cap is
 * needed. (Sampling proven by a red test bar → red status bar.) We do NOT touch
 * `theme-color` (mutating it made iOS fall back to the static black bar). The panel's
 * background also bleeds to `top:0` (content padded down by `SAFE_AREA_TOP`), so the
 * status bar reads sidebar-gray over the drawer's width and app-color to its right — the
 * drawer looks full-height, behind the island. The drawer renders into a portal on
 * `document.body` (like the old Sheet) to escape any ancestor stacking / compositing
 * context.
 *
 * Left-side only — the sole mobile usage. A right drawer would need the transform /
 * edge math mirrored.
 */

const WIDTH = "18rem"
const WIDTH_FALLBACK_PX = 288
// Left strip (px from the screen edge) where a touch begins an open-swipe.
const EDGE_ZONE = 24
// Movement (px) before we lock a gesture to horizontal-drag vs vertical-scroll.
const DIRECTION_LOCK = 8
// Settle open when dragged past this fraction of the panel width.
const OPEN_THRESHOLD = 0.4
// A flick faster than this (px/ms) settles in its direction regardless of position.
const FLICK_VELOCITY = 0.4
const EASING = "cubic-bezier(0.32, 0.72, 0, 1)"
const DURATION_MS = 300
// The panel's background bleeds to the very top edge (behind the Dynamic Island) so the
// sidebar gray reads full-height; its CONTENT is padded down by this inset so nothing sits
// under the island. Under `black-translucent` this is the real reported top inset (≈ the
// status-bar height), 0 off standalone.
const SAFE_AREA_TOP = "env(safe-area-inset-top)"

// The backdrop's dark fades IN below the status bar rather than starting at the top edge:
// iOS tints the translucent full-bleed status bar by sampling the webview's top row, so a
// hard dark overlay there darkens the bar (and creates an ugly seam). Kept clear through
// the safe-area inset (the status-bar band), easing to the full scrim over the 32px below
// it — env()-driven so it adapts to any device's inset, not just a Dynamic Island.
// Exported for tests: jsdom's CSS parser drops env()/calc() gradient values from applied
// inline styles, so the test asserts this constant directly.
export const BACKDROP_SCRIM =
  "linear-gradient(to bottom, rgba(0,0,0,0) 0, rgba(0,0,0,0) env(safe-area-inset-top), rgba(0,0,0,0.5) calc(env(safe-area-inset-top) + 32px))"

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// A touch landing on one of these is (probably) a tap, not an edge-swipe — so we
// leave its default alone rather than suppressing the OS back-swipe, keeping the tap.
const INTERACTIVE_SELECTOR =
  'a[href], button, input, textarea, select, label, [role="button"], [tabindex]:not([tabindex="-1"])'

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null
}

type GesturePhase = "pending" | "drag" | "abandoned"

type Gesture = {
  startX: number
  startY: number
  // Offset (px, 0..width) the panel is revealed at when the gesture began: 0 for an
  // open-swipe (from closed), `width` for a close-drag (from open).
  startOffset: number
  lastX: number
  lastT: number
  vx: number
  phase: GesturePhase
}

export interface MobileSidebarDrawerProps
  extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

export function MobileSidebarDrawer({
  open,
  onOpenChange,
  children,
  className,
  ...props
}: MobileSidebarDrawerProps) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const gestureRef = React.useRef<Gesture | null>(null)
  // Live drag offset kept in a ref for the (stable) gesture handlers to read, and
  // mirrored into state only to drive the panel/backdrop render while dragging.
  const offsetRef = React.useRef(0)
  const widthRef = React.useRef(WIDTH_FALLBACK_PX)
  // Keep the latest onOpenChange reachable from the stable document listeners.
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const [dragging, setDragging] = React.useState(false)
  const [dragOffset, setDragOffset] = React.useState(0)

  const reducedMotion = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  )

  const handleMove = React.useCallback((e: TouchEvent) => {
    const g = gestureRef.current
    if (!g || g.phase === "abandoned") return
    const t = e.touches[0]
    if (!t) return

    const dx = t.clientX - g.startX
    const dy = t.clientY - g.startY

    if (g.phase === "pending") {
      if (Math.abs(dx) < DIRECTION_LOCK && Math.abs(dy) < DIRECTION_LOCK) return
      // Vertical intent → let the browser scroll; bow out of this gesture.
      if (Math.abs(dy) >= Math.abs(dx)) {
        g.phase = "abandoned"
        return
      }
      g.phase = "drag"
      setDragging(true)
    }

    // Horizontal drag underway — stop the browser from scrolling/rubber-banding.
    e.preventDefault()
    const width = widthRef.current
    const offset = Math.min(width, Math.max(0, g.startOffset + dx))
    const dt = e.timeStamp - g.lastT
    if (dt > 0) g.vx = (t.clientX - g.lastX) / dt
    g.lastX = t.clientX
    g.lastT = e.timeStamp
    offsetRef.current = offset
    setDragOffset(offset)
  }, [])

  const detachListeners = React.useRef<() => void>(() => {})

  const handleEnd = React.useCallback(() => {
    detachListeners.current()
    const g = gestureRef.current
    gestureRef.current = null
    if (!g || g.phase !== "drag") return

    const width = widthRef.current
    const offset = offsetRef.current
    let target: boolean
    if (g.vx > FLICK_VELOCITY) target = true
    else if (g.vx < -FLICK_VELOCITY) target = false
    else target = offset > width * OPEN_THRESHOLD

    setDragging(false)
    setDragOffset(0)
    offsetRef.current = 0
    onOpenChangeRef.current(target)
  }, [])

  const beginGesture = React.useCallback(
    (clientX: number, clientY: number, mode: "open" | "close", timeStamp: number) => {
      if (gestureRef.current) return
      const width = panelRef.current?.offsetWidth || WIDTH_FALLBACK_PX
      widthRef.current = width
      const startOffset = mode === "open" ? 0 : width
      offsetRef.current = startOffset
      gestureRef.current = {
        startX: clientX,
        startY: clientY,
        startOffset,
        lastX: clientX,
        lastT: timeStamp,
        vx: 0,
        phase: "pending",
      }
      document.addEventListener("touchmove", handleMove, { passive: false })
      document.addEventListener("touchend", handleEnd)
      document.addEventListener("touchcancel", handleEnd)
      detachListeners.current = () => {
        document.removeEventListener("touchmove", handleMove)
        document.removeEventListener("touchend", handleEnd)
        document.removeEventListener("touchcancel", handleEnd)
      }
    },
    [handleMove, handleEnd]
  )

  // Edge-swipe-to-open + OS back-swipe suppression. A NON-passive, document-level
  // touchstart so we can preventDefault the edge touch (the only way to stop iOS's
  // left-edge swipe-back). We skip preventDefault when the touch lands on a real
  // control, so taps near the edge still fire — a horizontal drag off a control is
  // still caught by the (non-passive) move handler. Armed only while closed; when
  // open, a sibling document listener (below) owns the close-drag.
  React.useEffect(() => {
    if (open) return
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      if (t.clientX > EDGE_ZONE) return
      if (!isInteractiveTarget(e.target)) e.preventDefault()
      beginGesture(t.clientX, t.clientY, "open", e.timeStamp)
    }
    document.addEventListener("touchstart", onTouchStart, { passive: false })
    return () => document.removeEventListener("touchstart", onTouchStart)
  }, [open, beginGesture])

  // Detach any in-flight gesture listeners on unmount.
  React.useEffect(() => () => detachListeners.current(), [])

  // While open, make the rest of the app (#root) inert so screen readers / Tab can't reach
  // content behind the drawer (Radix Sheet did this for free). The drawer is portaled to
  // <body>, a sibling of #root, so it stays interactive.
  React.useEffect(() => {
    if (!open) return
    const root = document.getElementById("root")
    if (!root) return
    root.setAttribute("inert", "")
    return () => root.removeAttribute("inert")
  }, [open])

  // Drag-the-open-panel-left-to-close. A document-level native touchstart (NOT a React
  // `onTouchStart` on the panel): the panel is portaled to `document.body`, a sibling of
  // the React root (`#root`), so a native touch on it bubbles document-ward without ever
  // passing through the root where React 18 delegates events — the synthetic handler
  // never fires on-device (open works only because it's already a native listener). We
  // begin a close-drag when the touch lands on the panel; touches on the backdrop fall
  // through to its click-to-close. Passive (no preventDefault here) so taps and vertical
  // list-scroll are preserved — `handleMove` claims the gesture once it locks horizontal.
  React.useEffect(() => {
    if (!open) return
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      const panel = panelRef.current
      if (!panel || !(e.target instanceof Node) || !panel.contains(e.target)) return
      beginGesture(t.clientX, t.clientY, "close", e.timeStamp)
    }
    document.addEventListener("touchstart", onTouchStart, { passive: true })
    return () => document.removeEventListener("touchstart", onTouchStart)
  }, [open, beginGesture])

  // Focus management + Esc + Tab trap while open. Focus the panel on open, restore
  // to the previously-focused element (the trigger) on close.
  React.useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const prevActive = document.activeElement as HTMLElement | null
    panel?.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onOpenChangeRef.current(false)
        return
      }
      if (e.key !== "Tab" || !panel) return
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusables.length === 0) {
        e.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      prevActive?.focus?.({ preventScroll: true })
    }
  }, [open])

  // Hide the closed panel from the tab order + assistive tech. During a drag it's
  // being revealed, so keep it live.
  React.useEffect(() => {
    panelRef.current?.toggleAttribute("inert", !open && !dragging)
  }, [open, dragging])

  const settledTransition = reducedMotion
    ? "none"
    : `transform ${DURATION_MS}ms ${EASING}`
  const panelTransform = dragging
    ? `translateX(calc(-100% + ${dragOffset}px))`
    : open
      ? "translateX(0px)"
      : "translateX(-100%)"
  const backdropOpacity = dragging
    ? Math.min(1, Math.max(0, dragOffset / widthRef.current))
    : open
      ? 1
      : 0

  const drawer = (
    <>
      {/* Backdrop — its dark fades in below the status-bar zone (BACKDROP_SCRIM) so it
          never darkens the translucent iOS status bar, which iOS tints by sampling the
          webview's top row (see the status-bar note in the component doc). It's still
          fully present as a tap target across the whole area — alpha ≠ hit-testing. */}
      <div
        aria-hidden="true"
        data-testid="mobile-drawer-backdrop"
        onClick={() => onOpenChange(false)}
        className="fixed inset-x-0 top-0 h-screen z-40"
        style={{
          background: BACKDROP_SCRIM,
          opacity: backdropOpacity,
          transition: dragging || reducedMotion ? "none" : `opacity ${DURATION_MS}ms ${EASING}`,
          pointerEvents: open || dragging ? "auto" : "none",
          visibility: open || dragging ? "visible" : "hidden",
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        tabIndex={-1}
        data-sidebar="sidebar"
        data-mobile="true"
        className={cn(
          "fixed left-0 top-0 h-screen z-50 flex flex-col bg-sidebar text-sidebar-foreground shadow-xl outline-none",
          className
        )}
        style={{
          // Background bleeds to the top edge (behind the island); content is padded
          // down so it clears the status bar. Right side stays app color (see doc).
          paddingTop: SAFE_AREA_TOP,
          width: WIDTH,
          transform: panelTransform,
          transition: dragging ? "none" : settledTransition,
          touchAction: "pan-y",
        }}
        {...props}
      >
        {children}
      </div>
    </>
  )

  // Portal to <body> — like the old Sheet — so neither layer is trapped in an
  // ancestor stacking/compositing context.
  return typeof document !== "undefined"
    ? createPortal(drawer, document.body)
    : drawer
}
