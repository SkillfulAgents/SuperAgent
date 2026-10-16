import { useEffect, useRef } from 'react'

/**
 * Runs `onReturn` when the user comes back to the window: it regains focus, or
 * its tab becomes visible. Both fire on one return, so they are coalesced.
 */
export function useOnWindowReturn(onReturn: () => void, active = true): void {
  const latest = useRef(onReturn)
  latest.current = onReturn

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const onFocus = () => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        latest.current()
      }, 50)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onFocus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (timer !== null) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [active])
}
