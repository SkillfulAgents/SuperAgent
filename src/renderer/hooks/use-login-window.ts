import { useCallback, useEffect, useRef, useState } from 'react'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

export const LOGIN_WINDOW_CANCEL_DELAY_MS = 10_000

/**
 * `waiting`: the window is on the login page and the site's own completion
 * signal ends the wait. `no-url`: the request succeeded without a login URL,
 * so there is nothing to wait for. `stale`: `close()` or a newer `open()` ran
 * first, and the site must not touch state for this attempt.
 */
export type LoginWindowOutcome = 'waiting' | 'no-url' | 'stale'

/**
 * Owns a login window for its lifetime. `open` must be called synchronously
 * inside the click so popup blockers allow the window; the site supplies only
 * its request for the login URL. The window closes on `close()` (Cancel, or
 * the site's completion signal), on failure, and on unmount, and a response
 * that lands after any of those is dropped.
 *
 * `pending` is true from the click. `waiting` is true once the window has been
 * sent to the login page, which is when a completion listener should start.
 * `canCancel` turns true once an attempt has been pending for 10 s.
 */
export function useLoginWindow() {
  const [pending, setPending] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [canCancel, setCanCancel] = useState(false)
  // Each open() and close() bumps the attempt; a request that settles under a
  // different number than it started with is stale.
  const attemptRef = useRef(0)
  const popupRef = useRef<ReturnType<typeof prepareOAuthPopup> | null>(null)
  const cancelTimerRef = useRef<number | undefined>(undefined)

  const close = useCallback(() => {
    attemptRef.current++
    popupRef.current?.close()
    popupRef.current = null
    window.clearTimeout(cancelTimerRef.current)
    setPending(false)
    setWaiting(false)
    setCanCancel(false)
  }, [])

  useEffect(() => close, [close])

  const open = useCallback(async (
    requestLoginUrl: () => Promise<string | null | undefined>,
  ): Promise<LoginWindowOutcome> => {
    close()
    const popup = prepareOAuthPopup()
    popupRef.current = popup
    const attempt = attemptRef.current
    const stale = () => attempt !== attemptRef.current
    cancelTimerRef.current = window.setTimeout(() => setCanCancel(true), LOGIN_WINDOW_CANCEL_DELAY_MS)
    setPending(true)

    try {
      const url = await requestLoginUrl()
      if (stale()) return 'stale'
      if (!url) {
        close()
        return 'no-url'
      }
      setWaiting(true)
      await popup.navigate(url)
      return stale() ? 'stale' : 'waiting'
    } catch (err) {
      if (stale()) return 'stale'
      close()
      throw err
    }
  }, [close])

  return { open, close, pending, waiting, canCancel }
}
