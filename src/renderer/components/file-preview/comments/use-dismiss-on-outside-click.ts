import { useEffect, useRef } from 'react'

/**
 * Dismiss a transient popover (comment overlay, click point, text selection)
 * when the user mousedowns anywhere outside it. Clicks landing inside an
 * element matching one of `ignoreSelectors` are left alone.
 *
 * Shared by the text/image/CSV comment affordances, which all need the same
 * "click away to cancel" behaviour. The listener is only attached while
 * `active` is true and reads `onDismiss` through a ref, so it doesn't churn the
 * document listener on every render.
 */
export function useDismissOnOutsideClick(
  active: boolean,
  onDismiss: () => void,
  ignoreSelectors: string[] = [],
) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  const selector = ignoreSelectors.join(',')

  useEffect(() => {
    if (!active) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (selector && target.closest?.(selector)) return
      onDismissRef.current()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [active, selector])
}
