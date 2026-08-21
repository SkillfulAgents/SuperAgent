import { useEffect, useState } from 'react'

export const OAUTH_ABORT_DELAY_MS = 10_000

export function useDelayedOAuthAbort(active: boolean, delayMs = OAUTH_ABORT_DELAY_MS) {
  const [canAbort, setCanAbort] = useState(false)

  useEffect(() => {
    if (!active) {
      setCanAbort(false)
      return
    }

    setCanAbort(false)
    const timeout = window.setTimeout(() => setCanAbort(true), delayMs)
    return () => window.clearTimeout(timeout)
  }, [active, delayMs])

  return canAbort
}
