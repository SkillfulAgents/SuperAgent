// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"
import { MobileSidebarDrawer, BACKDROP_SCRIM } from "./mobile-sidebar-drawer"

afterEach(cleanup)

/**
 * Dispatch a touch event on `target` carrying a single touch point. jsdom has no
 * TouchEvent, so we hang a minimal `touches` list off a plain cancelable Event —
 * enough for the drawer's handlers (they read `touches[0].clientX/clientY`,
 * `touches.length`, `timeStamp`, and call `preventDefault`).
 */
function dispatchTouch(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  timeStamp = 0
) {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, "touches", {
    value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }],
  })
  // Control timeStamp so drag velocity is deterministic (jsdom's real inter-event
  // gap is ~microseconds → every drag would read as a fast flick otherwise).
  Object.defineProperty(e, "timeStamp", { value: timeStamp })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

function renderDrawer(props: Partial<React.ComponentProps<typeof MobileSidebarDrawer>> = {}) {
  const onOpenChange = props.onOpenChange ?? vi.fn()
  const utils = render(
    <MobileSidebarDrawer open={props.open ?? false} onOpenChange={onOpenChange}>
      <button data-testid="inner-btn">Agents</button>
    </MobileSidebarDrawer>
  )
  return { ...utils, onOpenChange }
}

describe("MobileSidebarDrawer — settled state", () => {
  it("renders the panel off-screen and inert when closed", () => {
    renderDrawer({ open: false })
    const panel = screen.getByRole("dialog", { hidden: true })
    expect(panel.style.transform).toBe("translateX(-100%)")
    expect(panel).toHaveAttribute("inert")
  })

  it("renders the panel on-screen and interactive when open", () => {
    renderDrawer({ open: true })
    const panel = screen.getByRole("dialog")
    expect(panel.style.transform).toBe("translateX(0px)")
    expect(panel).not.toHaveAttribute("inert")
  })

  it("moves focus into the panel on open", () => {
    renderDrawer({ open: true })
    const panel = screen.getByRole("dialog")
    expect(document.activeElement).toBe(panel)
  })

  it("marks the app root inert while open and restores it on close", () => {
    // Background content (#root) must be inert while open so AT/Tab can't reach it — the
    // drawer is portaled to <body>, outside #root, so it stays interactive.
    const root = document.createElement("div")
    root.id = "root"
    document.body.appendChild(root)
    try {
      const { rerender } = renderDrawer({ open: true })
      expect(root.hasAttribute("inert")).toBe(true)
      rerender(
        <MobileSidebarDrawer open={false} onOpenChange={vi.fn()}>
          <button>Agents</button>
        </MobileSidebarDrawer>
      )
      expect(root.hasAttribute("inert")).toBe(false)
    } finally {
      root.remove()
    }
  })

  it("gives the panel and backdrop a full-height box anchored at the top edge", () => {
    // Top-anchored + h-screen (not bottom-0) so they fill the full screen even in the
    // installed PWA, where `fixed bottom:0` anchors to the short dvh viewport (the
    // dvh/lvh mismatch that caused the bottom chin). h-screen → lvh in standalone.
    renderDrawer({ open: true })
    const panel = screen.getByRole("dialog")
    const backdrop = screen.getByTestId("mobile-drawer-backdrop")
    expect(panel).toHaveClass("top-0")
    expect(panel).toHaveClass("h-screen")
    expect(backdrop).toHaveClass("top-0")
    expect(backdrop).toHaveClass("h-screen")
  })

  it("bleeds the panel background to the top edge so the sidebar reads full-height", () => {
    // The panel is pinned to top:0 (behind the Dynamic Island) with bg-sidebar, so the
    // translucent status bar samples the sidebar gray over the drawer's width. Content is
    // kept clear of the island via padding-top (env(safe-area-inset-top), dropped by jsdom).
    renderDrawer({ open: true })
    const panel = screen.getByRole("dialog")
    expect(panel).toHaveClass("top-0")
    expect(panel).toHaveClass("bg-sidebar")
    expect(panel.className).not.toMatch(/\binset-y-0\b/)
  })

  it("fades the backdrop's dark in below the top edge (status-bar tint fix, no opaque cap)", () => {
    // iOS tints the translucent status bar from the webview's top row, so the backdrop is a
    // gradient that's clear through the safe-area inset and only reaches full dark below it —
    // the sampled row stays app-colored with no hard seam, and no opaque cap element. jsdom's
    // CSS parser drops env()/calc() gradient values from applied styles, so assert the scrim
    // constant directly (it's applied to the backdrop inline via `background`).
    expect(BACKDROP_SCRIM).toMatch(/linear-gradient/)
    expect(BACKDROP_SCRIM).toMatch(/rgba\(0,0,0,0\)/) // clear (transparent) at the very top edge
    expect(BACKDROP_SCRIM).toMatch(/env\(safe-area-inset-top\)/) // adapts to the device inset
    renderDrawer({ open: true })
    expect(screen.getByTestId("mobile-drawer-backdrop")).toBeTruthy()
    // No opaque cap element is rendered anymore.
    expect(screen.queryByTestId("mobile-drawer-statusbar-cap")).toBeNull()
  })

  it("never mutates the theme-color meta (iOS drops it on runtime change → black status bar)", () => {
    const meta = document.createElement("meta")
    meta.setAttribute("name", "theme-color")
    meta.setAttribute("content", "#1a1a1a")
    document.head.appendChild(meta)
    document.body.style.backgroundColor = "rgb(26, 26, 26)"

    const { rerender } = renderDrawer({ open: true })
    // Left untouched while open — mutating it is what made iOS fall back to the
    // static apple black status bar and stick there.
    expect(meta.getAttribute("content")).toBe("#1a1a1a")

    rerender(
      <MobileSidebarDrawer open={false} onOpenChange={vi.fn()}>
        <button>Agents</button>
      </MobileSidebarDrawer>
    )
    expect(meta.getAttribute("content")).toBe("#1a1a1a")

    meta.remove()
    document.body.style.backgroundColor = ""
  })

  it("passes through className and extra props to the panel", () => {
    render(
      <MobileSidebarDrawer open onOpenChange={vi.fn()} data-testid="app-sidebar" className="custom-x">
        <span>content</span>
      </MobileSidebarDrawer>
    )
    const panel = screen.getByTestId("app-sidebar")
    expect(panel).toHaveClass("custom-x")
    expect(panel).toHaveAttribute("role", "dialog")
  })
})

describe("MobileSidebarDrawer — dismissal", () => {
  it("closes when the backdrop is clicked", () => {
    const { onOpenChange } = renderDrawer({ open: true })
    fireEvent.click(screen.getByTestId("mobile-drawer-backdrop"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("closes on Escape while open", () => {
    const { onOpenChange } = renderDrawer({ open: true })
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("does not listen for Escape while closed", () => {
    const { onOpenChange } = renderDrawer({ open: false })
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("MobileSidebarDrawer — edge-swipe gesture", () => {
  it("opens when swiped in from the left edge past the threshold", () => {
    const { onOpenChange } = renderDrawer({ open: false })
    // Start inside the edge zone, drag well past 40% of the 288px fallback width,
    // slowly (large dt → no flick) so the position threshold is what decides.
    dispatchTouch(document, "touchstart", 10, 300, 0)
    dispatchTouch(document, "touchmove", 200, 300, 1000)
    dispatchTouch(document, "touchend", 200, 300, 1000)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it("snaps back closed when the swipe stops short of the threshold", () => {
    const { onOpenChange } = renderDrawer({ open: false })
    dispatchTouch(document, "touchstart", 10, 300, 0)
    // ~40px reveal — under 40% of 288px — and slow (no flick).
    dispatchTouch(document, "touchmove", 50, 300, 1000)
    dispatchTouch(document, "touchend", 50, 300, 1000)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("opens on a fast flick even below the position threshold", () => {
    const { onOpenChange } = renderDrawer({ open: false })
    dispatchTouch(document, "touchstart", 10, 300, 0)
    // Only ~40px revealed, but fast (dt=10ms → ~4px/ms) → flick-open.
    dispatchTouch(document, "touchmove", 50, 300, 10)
    dispatchTouch(document, "touchend", 50, 300, 10)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it("ignores a touch that starts outside the edge zone", () => {
    const { onOpenChange } = renderDrawer({ open: false })
    dispatchTouch(document, "touchstart", 200, 300, 0)
    dispatchTouch(document, "touchmove", 260, 300, 1000)
    dispatchTouch(document, "touchend", 260, 300, 1000)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("claims a non-interactive edge touch (preventDefault) to suppress the OS back-swipe", () => {
    renderDrawer({ open: false })
    const e = dispatchTouch(document.body, "touchstart", 8, 300, 0)
    expect(e.defaultPrevented).toBe(true)
  })

  it("does not claim a touch that begins on a control — the tap is preserved", () => {
    renderDrawer({ open: false })
    const btn = document.createElement("button")
    document.body.appendChild(btn)
    const e = dispatchTouch(btn, "touchstart", 8, 300, 0)
    expect(e.defaultPrevented).toBe(false)
    btn.remove()
  })

  it("does not claim (preventDefault) a touch outside the edge zone", () => {
    renderDrawer({ open: false })
    const e = dispatchTouch(document.body, "touchstart", 200, 300, 0)
    expect(e.defaultPrevented).toBe(false)
  })

  it("abandons the gesture (no open) on a mostly-vertical swipe", () => {
    const { onOpenChange } = renderDrawer({ open: false })
    dispatchTouch(document, "touchstart", 10, 300, 0)
    // Vertical dominates → let the browser scroll, don't open.
    dispatchTouch(document, "touchmove", 16, 400, 100)
    dispatchTouch(document, "touchend", 16, 400, 100)
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("MobileSidebarDrawer — drag-to-close gesture", () => {
  it("closes when the open panel is dragged left past the threshold", () => {
    const { onOpenChange } = renderDrawer({ open: true })
    const panel = screen.getByRole("dialog")
    // Close-drag begins on the panel (start offset = full width, 288px fallback),
    // slid slowly down to ~78px revealed — under threshold → closes.
    dispatchTouch(panel, "touchstart", 250, 300, 0)
    dispatchTouch(document, "touchmove", 40, 300, 1000)
    dispatchTouch(document, "touchend", 40, 300, 1000)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("begins the close-drag from a touch on a control inside the panel", () => {
    // The real device case: the panel is full of tappable list items, so the touch
    // lands on a child, not the panel root. Close listens at the document (the panel is
    // portaled outside the React root, so a React onTouchStart would never fire), so a
    // touchstart that bubbles up from any panel descendant still starts the close-drag.
    const { onOpenChange } = renderDrawer({ open: true })
    const inner = screen.getByTestId("inner-btn")
    dispatchTouch(inner, "touchstart", 250, 300, 0)
    dispatchTouch(document, "touchmove", 40, 300, 1000)
    dispatchTouch(document, "touchend", 40, 300, 1000)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("leaves a touch on the backdrop to click-to-close, not the drag path", () => {
    // A touch outside the panel (on the backdrop) must NOT start a close-drag — it falls
    // through to the backdrop's click handler. A drag from there would be a no-op that
    // also swallows the tap.
    const { onOpenChange } = renderDrawer({ open: true })
    const backdrop = screen.getByTestId("mobile-drawer-backdrop")
    dispatchTouch(backdrop, "touchstart", 320, 300, 0)
    dispatchTouch(document, "touchmove", 300, 300, 1000)
    dispatchTouch(document, "touchend", 300, 300, 1000)
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
