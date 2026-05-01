/**
 * Thin shim around the View Transitions API. Falls back to running the
 * callback synchronously when the browser does not support it (Safari < 18,
 * Firefox pre-136).
 */
export function startViewTransition(cb: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(cb)
  } else {
    cb()
  }
}
