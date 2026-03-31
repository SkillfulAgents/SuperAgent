// Public API for render tracking.
// When __RENDER_TRACKING__ is off, useRenderTracker is a no-op.
// When on, render-tracking.ts replaces it with the real implementation.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export let useRenderTracker: (componentName: string) => void = (_name: string) => {}

export function _setRenderTracker(fn: typeof useRenderTracker) {
  useRenderTracker = fn
}
