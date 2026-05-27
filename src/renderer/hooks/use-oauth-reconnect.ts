import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

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
          window.electronAPI!.onOAuthCallback(async (params) => {
            if (params.toolkit && params.toolkit !== toolkit) return
            window.electronAPI?.removeOAuthCallback()
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
