// One observer for the whole avatar population. Offscreen rows never enter
// the frame loop while waiting for their first intersection notification.
const listeners = new Map<Element, (visible: boolean) => void>()
let observer: IntersectionObserver | null = null

export function observeOrbVisibility(element: Element, listener: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    listener(true)
    return () => {}
  }
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        // An edge touching the viewport can be intersecting with zero visible area.
        listeners.get(entry.target)?.(entry.isIntersecting && entry.intersectionRatio > 0)
      }
    }, {
      // Threshold zero need not notify again when an edge-touching element
      // gains visible area. A positive threshold makes that transition observable.
      threshold: Number.EPSILON,
    })
  }
  listeners.set(element, listener)
  observer.observe(element)
  return () => {
    listeners.delete(element)
    observer?.unobserve(element)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}
