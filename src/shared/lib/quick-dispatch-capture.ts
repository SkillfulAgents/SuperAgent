/**
 * The dispatch launcher's screenshot, shared by main (which takes it and plays
 * the animation that carries it into the composer), the preload bridge and the
 * launcher's renderer. Dependency-free so all three can import it.
 */

/** What main answers when the launcher asks for the screen. */
export type QuickDispatchCaptureResult =
  | { ok: true; png: Uint8Array<ArrayBuffer>; name: string }
  /** `permission`: macOS has not given the app Screen Recording. */
  | { ok: false; reason: 'permission' | 'failed' }

/** A rectangle in CSS pixels: the attachment chip in the launcher's viewport, or a place on the overlay. */
export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

/** The screenshot's file name, as macOS names one: "Screenshot 2026-11-02 at 14.03.22.png", local time. */
export function screenshotFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  return `Screenshot ${day} at ${time}.png`
}

/**
 * Where the chip is on the overlay: the launcher reports it in its own
 * viewport, the launcher's content sits somewhere on the display, and the
 * overlay covers that display from its origin.
 */
export function chipOnOverlay(
  chip: CaptureRect,
  launcherContent: { x: number; y: number },
  display: { x: number; y: number },
): CaptureRect {
  return {
    x: launcherContent.x - display.x + chip.x,
    y: launcherContent.y - display.y + chip.y,
    width: chip.width,
    height: chip.height,
  }
}

/** Whether a value from the renderer is a usable rectangle. */
export function isCaptureRect(value: unknown): value is CaptureRect {
  if (!value || typeof value !== 'object') return false
  const { x, y, width, height } = value as Record<string, unknown>
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (width as number) > 0 && (height as number) > 0
}
