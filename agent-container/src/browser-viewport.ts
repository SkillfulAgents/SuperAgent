/**
 * Viewport override for a browser-input handoff: narrow the streamed page so a
 * site reflows to its own phone layout and the sign-in form fills the drawer
 * instead of rendering a desktop page at a third of native scale.
 */
import { inputManager } from './input-manager'

/** Under the classic `max-width: 480px` phone breakpoint, and equal to the
 *  drawer's default width, so the common case renders at 1:1. */
const HANDOFF_VIEWPORT_WIDTH = 450
/** Only controls how much page arrives per scroll — the canvas container is
 *  bounded on the renderer side, so this cannot clip the handoff controls. */
const HANDOFF_VIEWPORT_HEIGHT = 900

/**
 * The screencast connection's two outbound paths: CDP to the page, and a mode
 * report to the viewer so the tray never has to infer the mode from frame size.
 */
export interface ViewportChannel {
  sendCdp: (method: string, params?: Record<string, unknown>) => void
  reportDesktopWidth: (enabled: boolean) => void
}

let channel: ViewportChannel | null = null
let desktopRequested = false

export function setViewportChannel(next: ViewportChannel | null): void {
  channel = next
}

/**
 * Re-derive whenever the pending map changes, wherever that change came from.
 * Called once at startup. Subscribing beats a sync call at each of the seven
 * routes that add or clear a handoff, which is a rule three of them missed.
 */
export function startBrowserViewportSync(): void {
  inputManager.onPendingChange(syncBrowserViewport)
}

/** The user asked for desktop width for the current handoff, or took it back. */
export function requestDesktopWidth(enabled: boolean): void {
  desktopRequested = enabled
  syncBrowserViewport()
}

/**
 * Drop the channel on screencast teardown, keeping the escape flag while a
 * handoff is still pending so a viewer reconnect re-derives desktop width.
 * Browser-close paths reject pendings and then sync, which clears it.
 */
export function detachViewportChannel(): void {
  channel = null
  if (!hasPendingHandoff()) desktopRequested = false
}

function hasPendingHandoff(): boolean {
  return inputManager.getAllPending().some((p) => p.inputType === 'browser_input')
}

/**
 * Derive the correct viewport from current state and issue at most one CDP
 * command. Safe to call at any time, including with no screencast connected.
 */
export function syncBrowserViewport(): void {
  const hasHandoff = hasPendingHandoff()

  // Scope the escape hatch to a single handoff: once the last one closes, the
  // next handoff starts narrow again.
  if (!hasHandoff) desktopRequested = false

  if (!channel) return

  if (hasHandoff && !desktopRequested) {
    channel.sendCdp('Emulation.setDeviceMetricsOverride', {
      width: HANDOFF_VIEWPORT_WIDTH,
      height: HANDOFF_VIEWPORT_HEIGHT,
      // Required. Omitting it makes CDP reject the call with Invalid parameters.
      deviceScaleFactor: 1,
      // Load-bearing. With `mobile: true` a page carrying no viewport meta tag
      // gets Chrome's 980px fallback scaled to fit, which is worse than doing
      // nothing. On well-behaved sites the two settings are identical.
      mobile: false,
    })
  } else {
    channel.sendCdp('Emulation.clearDeviceMetricsOverride')
  }

  // Tell the viewer what we just applied. The tray renders this directly, so it
  // never has to guess the mode from the width of an arriving frame.
  channel.reportDesktopWidth(desktopRequested)
}
