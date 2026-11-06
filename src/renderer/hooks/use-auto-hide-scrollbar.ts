import { useCallback, useEffect, useRef } from 'react'

/** How long the bar stays after the last scroll event. */
const HIDE_AFTER_MS = 900

/**
 * Show a scroller's bar only while it scrolls. Call the returned function from
 * the scroller's onScroll: it sets `data-scrolling` on the element (styled by
 * `.auto-hide-scrollbar` in globals.css) and clears it a moment after the last
 * scroll. Written straight to the DOM, so scrolling never re-renders.
 */
export function useAutoHideScrollbar(): (element: HTMLElement) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return useCallback((element: HTMLElement) => {
    element.setAttribute('data-scrolling', '')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => element.removeAttribute('data-scrolling'), HIDE_AFTER_MS)
  }, [])
}
