import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { useDelayedOAuthAbort } from '@renderer/hooks/use-delayed-oauth-abort'

// Upper bound on how long we wait for the OAuth callback before giving up and
// cleaning up the IPC listener. Generous enough for a slow login (incl. MFA),
// short enough that an abandoned flow doesn't leak a listener for the session.
const OAUTH_RECONNECT_TIMEOUT_MS = 5 * 60 * 1000

export function useOAuthReconnect() {
  const queryClient = useQueryClient()
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)
  const abortReconnectRef = useRef<(() => void) | null>(null)
  const canCancelPendingReconnect = useDelayedOAuthAbort(pendingAccountId !== null)

  const cancelReconnect = useCallback(() => {
    abortReconnectRef.current?.()
  }, [])

  const reconnect = useCallback(async (accountId: string, toolkit: string) => {
    const popup = prepareOAuthPopup()
    let canceled = false
    abortReconnectRef.current = () => {
      canceled = true
      popup.close()
      setPendingAccountId(null)
    }
    setPendingAccountId(accountId)
    try {
      const res = await apiFetch('/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerSlug: toolkit,
          electron: !!window.electronAPI,
          reconnectAccountId: accountId,
        }),
      })
      if (canceled) return
      if (!res.ok) {
        popup.close()
        const data = await res.json()
        console.error('Failed to initiate reconnection:', data.error)
        setPendingAccountId(null)
        return
      }
      const data = await res.json()
      if (canceled) return
      if (!data.redirectUrl) {
        popup.close()
        setPendingAccountId(null)
        return
      }

      await popup.navigate(data.redirectUrl)
      if (canceled) return

      if (window.electronAPI) {
        await new Promise<void>((resolve) => {
          let settled = false
          let timeout: number | undefined
          let unsubscribe: (() => void) | undefined
          // Tear down the listener and clear the timeout exactly once. Returns
          // false if already settled so a late callback / timeout race no-ops.
          const settle = (): boolean => {
            if (settled) return false
            settled = true
            if (timeout) window.clearTimeout(timeout)
            unsubscribe?.()
            return true
          }
          abortReconnectRef.current = () => {
            canceled = true
            popup.close()
            if (settle()) resolve()
          }
          // Bound the wait: if the user abandons the OAuth window (or only
          // mismatched-toolkit callbacks ever arrive), settle anyway so we don't
          // leak the listener or hang reconnect() forever. The channel-wide
          // reset that used to sweep orphaned listeners is gone (SUP-215).
          timeout = window.setTimeout(() => {
            if (settle()) resolve()
          }, OAUTH_RECONNECT_TIMEOUT_MS)
          unsubscribe = window.electronAPI!.onOAuthCallback(async (params) => {
            // Ignore callbacks for other toolkits; keep waiting for ours.
            if (params.toolkit && params.toolkit !== toolkit) return
            // Remove only this reconnect listener; other OAuth subscribers stay.
            if (!settle()) return
            if (params.connectionId && params.toolkit) {
              await apiFetch('/api/connected-accounts/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  connectionId: params.connectionId,
                  toolkit: params.toolkit,
                  reconnectAccountId: accountId,
                }),
              }).catch(() => {})
            }
            resolve()
          })
        })
      } else {
        await new Promise<void>((resolve) => {
          let settled = false
          let timeout: number | undefined

          function settle(): boolean {
            if (settled) return false
            settled = true
            if (timeout) window.clearTimeout(timeout)
            window.removeEventListener('message', handleMessage)
            return true
          }

          function handleMessage(event: MessageEvent) {
            if (event.origin !== window.location.origin) return
            if (event.data?.type === 'oauth-callback') {
              if (settle()) resolve()
            }
          }
          abortReconnectRef.current = () => {
            canceled = true
            popup.close()
            if (settle()) resolve()
          }
          timeout = window.setTimeout(() => {
            if (settle()) resolve()
          }, OAUTH_RECONNECT_TIMEOUT_MS)
          window.addEventListener('message', handleMessage)
        })
      }

      if (canceled) return
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts'] })
    } catch (err) {
      popup.close()
      console.error('Reconnect failed:', err)
    } finally {
      abortReconnectRef.current = null
      setPendingAccountId(null)
    }
  }, [queryClient])

  return { reconnect, pendingAccountId, canCancelPendingReconnect, cancelReconnect }
}
