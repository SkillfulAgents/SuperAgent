/**
 * Posts to a dashboard frame's document, targeting the origin its src names.
 * That is the API origin, which in Electron differs from the app's own, so
 * neither `*` nor the app's origin is right. A frame that has wandered to
 * another origin simply doesn't receive it. False when there is no window or
 * no readable src.
 */
export function postToDashboardFrame(frame: HTMLIFrameElement | null, message: Record<string, unknown>): boolean {
  if (!frame?.contentWindow) return false
  let targetOrigin: string
  try {
    targetOrigin = new URL(frame.src, window.location.href).origin
  } catch {
    return false
  }
  frame.contentWindow.postMessage(message, targetOrigin)
  return true
}
