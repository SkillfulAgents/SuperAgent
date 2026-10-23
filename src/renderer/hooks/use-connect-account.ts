import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@renderer/lib/api'
import { openExternalUrl } from '@renderer/lib/open-external'
import { useInitiateConnection, useInvalidateConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import { getProvider } from '@shared/lib/account-providers/service-catalog'

export interface NewApiConnection {
  accountId: string
  toolkit: string
}

/**
 * Connect a new account of a provider in place: open its sign-in (a popup on
 * the web, the browser on the desktop), wait for the callback, complete the
 * account and refresh the account lists. The connections directory and a
 * drive's account step both connect through it, so the two never drift. A
 * provider with an install page (an app installed rather than signed in to)
 * opens that page instead and reports nothing back.
 *
 * `onConnected` gets the new account; `onConnectedWithoutAccount` runs when a
 * sign-in succeeds without naming one.
 */
export function useConnectAccount({
  location,
  onConnected,
  onConnectedWithoutAccount,
}: {
  /** Where the connection was made, for analytics. */
  location: string
  onConnected: (connection: NewApiConnection) => void
  onConnectedWithoutAccount?: () => void
}) {
  const initiateConnection = useInitiateConnection()
  const invalidateAccounts = useInvalidateConnectedAccounts()

  const loginWindow = useLoginWindow()
  const closeLoginWindow = loginWindow.close
  const [launchedSlug, setLaunchedSlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connecting = loginWindow.pending ? launchedSlug : null
  const connectingRef = useRef(connecting)
  connectingRef.current = connecting

  const cancel = useCallback(() => {
    closeLoginWindow()
    setError(null)
  }, [closeLoginWindow])

  useEffect(() => {
    if (!connecting) return

    const handleComplete = (success: boolean, accountId?: string, toolkit?: string) => {
      const resolvedToolkit = toolkit || connectingRef.current
      closeLoginWindow()
      if (success) {
        invalidateAccounts()
        if (accountId && resolvedToolkit) {
          onConnected({ accountId, toolkit: resolvedToolkit })
        } else {
          onConnectedWithoutAccount?.()
        }
      }
    }

    if (window.electronAPI) {
      const unsubscribe = window.electronAPI.onOAuthCallback(async (params) => {
        if (params.toolkit && params.toolkit !== connectingRef.current) return
        if (params.error || params.status === 'failed') {
          handleComplete(false)
          return
        }
        if (params.connectionId && params.toolkit) {
          try {
            const res = await apiFetch('/api/connected-accounts/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                connectionId: params.connectionId,
                toolkit: params.toolkit,
              }),
            })
            if (res.ok) {
              const data = await res.json()
              handleComplete(true, data.account?.id, params.toolkit)
            } else {
              handleComplete(false)
            }
          } catch {
            handleComplete(false)
          }
        } else {
          handleComplete(false)
        }
      })
      return () => { unsubscribe?.() }
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        if (event.data.toolkitSlug && event.data.toolkitSlug !== connectingRef.current) return
        handleComplete(event.data.success, event.data.accountId, event.data.toolkitSlug)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [connecting, closeLoginWindow, invalidateAccounts, onConnected, onConnectedWithoutAccount])

  const connect = useCallback(async (slug: string) => {
    const installUrl = getProvider(slug)?.installUrl
    if (installUrl) {
      void openExternalUrl(installUrl)
      return
    }
    setLaunchedSlug(slug)
    setError(null)
    try {
      await loginWindow.open(async () => {
        const result = await initiateConnection.mutateAsync({
          providerSlug: slug,
          electron: !!window.electronAPI,
          location,
        })
        return 'redirectUrl' in result ? result.redirectUrl : null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    }
  }, [loginWindow, initiateConnection, location])

  return {
    connect,
    /** The provider whose sign-in is open, if any. */
    connecting,
    canCancel: loginWindow.canCancel,
    cancel,
    error,
  }
}
