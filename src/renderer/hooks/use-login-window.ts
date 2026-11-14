import { useCallback, useEffect, useRef, useState } from 'react'
import { prepareAuthSession, prepareOAuthPopup, type LoginWindow } from '@renderer/lib/oauth-popup'

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
 * `isLoginWindow` tells whether a message came from the open window.
 *
 * With `authSession` the login is a sign-in sheet on the app's own window
 * instead of a browser window; closing the sheet ends the attempt.
 */
export function useLoginWindow({ authSession = false }: { authSession?: boolean } = {}) {
  const [pending, setPending] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [canCancel, setCanCancel] = useState(false)
  // Each open() and close() bumps the attempt; a request that settles under a
  // different number than it started with is stale.
  const attemptRef = useRef(0)
  const popupRef = useRef<LoginWindow | null>(null)
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

  const isLoginWindow = useCallback(
    (source: MessageEventSource | null) => popupRef.current?.isSource(source) ?? false,
    [],
  )

  const open = useCallback(async (
    requestLoginUrl: () => Promise<string | null | undefined>,
    { withApple = false }: { withApple?: boolean } = {},
  ): Promise<LoginWindowOutcome> => {
    close()
    const attempt = attemptRef.current
    const stale = () => attempt !== attemptRef.current
    const popup = authSession
      ? prepareAuthSession(() => { if (!stale()) close() }, withApple)
      : prepareOAuthPopup()
    popupRef.current = popup
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
  }, [close, authSession])

  return { open, close, pending, waiting, canCancel, isLoginWindow }
}
