import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

// Upper bound on how long we wait for the OAuth callback before giving up and
// cleaning up the IPC listener. Generous enough for a slow login (incl. MFA),
// short enough that an abandoned flow doesn't leak a listener for the session.
const OAUTH_RECONNECT_TIMEOUT_MS = 5 * 60 * 1000

export function useOAuthReconnect() {
  const queryClient = useQueryClient()
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)

  const reconnect = useCallback(async (accountId: string, toolkit: string) => {
    const popup = prepareOAuthPopup()
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
      if (!res.ok) {
        popup.close()
        const data = await res.json()
        console.error('Failed to initiate reconnection:', data.error)
        setPendingAccountId(null)
        return
      }
      const data = await res.json()
      if (!data.redirectUrl) {
        popup.close()
        setPendingAccountId(null)
        return
      }

      await popup.navigate(data.redirectUrl)

      if (window.electronAPI) {
        await new Promise<void>((resolve) => {
          let settled = false
          let unsubscribe: (() => void) | undefined
          // Tear down the listener and clear the timeout exactly once. Returns
          // false if already settled so a late callback / timeout race no-ops.
          const settle = (): boolean => {
            if (settled) return false
            settled = true
            clearTimeout(timeout)
            unsubscribe?.()
            return true
          }
          // Bound the wait: if the user abandons the OAuth window (or only
          // mismatched-toolkit callbacks ever arrive), settle anyway so we don't
          // leak the listener or hang reconnect() forever. The channel-wide
          // reset that used to sweep orphaned listeners is gone (SUP-215).
          const timeout = setTimeout(() => {
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
          const handleMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return
            if (event.data?.type === 'oauth-callback') {
              window.removeEventListener('message', handleMessage)
              resolve()
            }
          }
          window.addEventListener('message', handleMessage)
        })
      }

      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts'] })
    } catch (err) {
      popup.close()
      console.error('Reconnect failed:', err)
    } finally {
      setPendingAccountId(null)
    }
  }, [queryClient])

  return { reconnect, pendingAccountId }
}
