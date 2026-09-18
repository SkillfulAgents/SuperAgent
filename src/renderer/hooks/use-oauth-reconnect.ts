import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useLoginWindow } from '@renderer/hooks/use-login-window'

// Upper bound on how long we wait for the OAuth callback before giving up and
// cleaning up the IPC listener. Generous enough for a slow login (incl. MFA),
// short enough that an abandoned flow doesn't leak a listener for the session.
const OAUTH_RECONNECT_TIMEOUT_MS = 5 * 60 * 1000

export function useOAuthReconnect() {
  const queryClient = useQueryClient()
  const { open, close, pending, canCancel } = useLoginWindow()
  const [launchedAccountId, setLaunchedAccountId] = useState<string | null>(null)
  // Settles the inline wait for the callback when the user cancels.
  const abortWaitRef = useRef<(() => void) | null>(null)

  const cancelReconnect = useCallback(() => {
    close()
    abortWaitRef.current?.()
  }, [close])

  const reconnect = useCallback(async (accountId: string, toolkit: string) => {
    // One window at a time: a reconnect still waiting is superseded, so its
    // timeout cannot close the window this one is about to open.
    abortWaitRef.current?.()
    setLaunchedAccountId(accountId)
    let canceled = false
    try {
      const outcome = await open(async () => {
        const res = await apiFetch('/api/connected-accounts/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerSlug: toolkit,
            electron: !!window.electronAPI,
            reconnectAccountId: accountId,
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          console.error('Failed to initiate reconnection:', data.error)
          return null
        }
        return data.redirectUrl
      })
      if (outcome !== 'waiting') return false

      let reconnectSucceeded = false

      if (window.electronAPI) {
        reconnectSucceeded = await new Promise<boolean>((resolve) => {
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
          abortWaitRef.current = () => {
            canceled = true
            if (settle()) resolve(false)
          }
          // Bound the wait: if the user abandons the OAuth window (or only
          // mismatched-toolkit callbacks ever arrive), settle anyway so we don't
          // leak the listener or hang reconnect() forever. The channel-wide
          // reset that used to sweep orphaned listeners is gone (SUP-215).
          timeout = window.setTimeout(() => {
            if (settle()) resolve(false)
          }, OAUTH_RECONNECT_TIMEOUT_MS)
          unsubscribe = window.electronAPI!.onOAuthCallback(async (params) => {
            // Ignore callbacks for other toolkits; keep waiting for ours.
            if (params.toolkit && params.toolkit !== toolkit) return
            // Remove only this reconnect listener; other OAuth subscribers stay.
            if (!settle()) return
            if (params.connectionId && params.toolkit) {
              try {
                const completeRes = await apiFetch('/api/connected-accounts/complete', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    connectionId: params.connectionId,
                    toolkit: params.toolkit,
                    reconnectAccountId: accountId,
                  }),
                })
                resolve(completeRes.ok)
              } catch {
                resolve(false)
              }
              return
            }
            resolve(false)
          })
        })
      } else {
        reconnectSucceeded = await new Promise<boolean>((resolve) => {
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
              if (settle()) resolve(event.data?.success === true)
            }
          }
          abortWaitRef.current = () => {
            canceled = true
            if (settle()) resolve(false)
          }
          timeout = window.setTimeout(() => {
            if (settle()) resolve(false)
          }, OAUTH_RECONNECT_TIMEOUT_MS)
          window.addEventListener('message', handleMessage)
        })
      }

      if (canceled) return false
      close()
      queryClient.invalidateQueries({ queryKey: ['connected-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts'] })
      queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
      return reconnectSucceeded
    } catch (err) {
      if (!canceled) close()
      console.error('Reconnect failed:', err)
      return false
    }
  }, [queryClient, open, close])

  return {
    reconnect,
    pendingAccountId: pending ? launchedAccountId : null,
    canCancelPendingReconnect: canCancel,
    cancelReconnect,
  }
}
