import { apiFetch } from '@renderer/lib/api'

import { useState, useEffect, useCallback } from 'react'
import {
  Link2,
  Check,
  X,
  Loader2,
  Plus,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { cn } from '@shared/lib/utils/cn'
import {
  useConnectedAccountsByToolkit,
  useInvalidateConnectedAccounts,
  type ConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import { getProvider } from '@shared/lib/composio/providers'

interface ConnectedAccountRequestItemProps {
  toolUseId: string
  toolkit: string
  reason?: string
  sessionId: string
  agentSlug: string
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined' | 'connecting'

export function ConnectedAccountRequestItem({
  toolUseId,
  toolkit,
  reason,
  sessionId,
  agentSlug,
  onComplete,
}: ConnectedAccountRequestItemProps) {
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const { data, isLoading, refetch } = useConnectedAccountsByToolkit(toolkit)
  const invalidateConnectedAccounts = useInvalidateConnectedAccounts()

  const provider = getProvider(toolkit)
  const accounts = data?.accounts ?? []

  // Listen for OAuth callback messages (both IPC in Electron and postMessage in web)
  useEffect(() => {
    // Handle OAuth completion
    const handleOAuthComplete = (success: boolean, errorMessage?: string) => {
      if (success) {
        // Refresh the accounts list
        invalidateConnectedAccounts()
        refetch()
        setStatus('pending')
      } else {
        setError(errorMessage || 'OAuth connection failed')
        setStatus('pending')
      }
    }

    // Electron: use IPC callback with structured params
    if (window.electronAPI) {
      window.electronAPI.onOAuthCallback(async (params) => {
        if (params.error || params.status === 'failed') {
          handleOAuthComplete(false, params.error || undefined)
          return
        }

        // Complete the OAuth by calling the API
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
              handleOAuthComplete(true)
            } else {
              const data = await res.json()
              handleOAuthComplete(false, data.error)
            }
          } catch (error: any) {
            handleOAuthComplete(false, error.message)
          }
        } else {
          handleOAuthComplete(false, 'Missing OAuth callback parameters')
        }
      })
      return () => {
        window.electronAPI?.removeOAuthCallback()
      }
    }

    // Web: use postMessage from OAuth popup
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        handleOAuthComplete(event.data.success, event.data.error)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [invalidateConnectedAccounts, refetch])

  const toggleAccount = useCallback((accountId: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev)
      if (next.has(accountId)) {
        next.delete(accountId)
      } else {
        next.add(accountId)
      }
      return next
    })
  }, [])

  const handleConnectNew = async () => {
    setStatus('connecting')
    setError(null)

    try {
      // Pass electron flag to get correct callback URL
      const isElectronApp = !!window.electronAPI
      const response = await apiFetch('/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerSlug: toolkit, electron: isElectronApp }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to initiate connection')
      }

      const { redirectUrl } = await response.json()

      // Open OAuth in system browser (Electron) or new tab (web)
      if (window.electronAPI) {
        await window.electronAPI.openExternal(redirectUrl)
      } else {
        window.open(redirectUrl, '_blank')
      }
      setStatus('pending')
    } catch (err: any) {
      setError(err.message || 'Failed to connect account')
      setStatus('pending')
    }
  }

  const handleProvide = async () => {
    if (selectedAccountIds.size === 0) return

    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/provide-connected-account`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            toolkit,
            accountIds: Array.from(selectedAccountIds),
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to provide access')
      }

      setStatus('provided')
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to provide access')
      setStatus('pending')
    }
  }

  const handleDecline = async () => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/provide-connected-account`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            toolkit,
            decline: true,
            declineReason: 'User declined to provide access',
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to decline request')
      }

      setStatus('declined')
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to decline request')
      setStatus('pending')
    }
  }

  // Completed state
  if (status === 'provided' || status === 'declined') {
    return (
      <div className="border rounded-md bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <Link2
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'provided' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="font-medium capitalize">
            {provider?.displayName || toolkit}
          </span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'provided' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'provided' ? 'Access Granted' : 'Declined'}
          </span>
        </div>
      </div>
    )
  }

  // Pending/submitting/connecting state
  return (
    <div className="border rounded-md bg-blue-50 border-blue-200 text-sm">
      <div className="flex items-start gap-3 p-3">
        {/* Icon */}
        <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
          <Link2 className="h-4 w-4 text-blue-600" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Header */}
          <div>
            <div className="font-medium text-blue-900">
              Access Requested:{' '}
              <span className="capitalize">
                {provider?.displayName || toolkit}
              </span>
            </div>
            {reason && (
              <p className="text-sm text-blue-700 mt-1">{reason}</p>
            )}
          </div>

          {/* Account Selection */}
          {isLoading ? (
            <div className="flex items-center gap-2 text-blue-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading accounts...</span>
            </div>
          ) : accounts.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-blue-600 font-medium">
                Select account(s) to provide:
              </p>
              <div className="space-y-1">
                {accounts.map((account) => (
                  <AccountOption
                    key={account.id}
                    account={account}
                    selected={selectedAccountIds.has(account.id)}
                    onToggle={() => toggleAccount(account.id)}
                    disabled={status !== 'pending'}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-blue-600">
              No connected accounts found for {provider?.displayName || toolkit}.
            </p>
          )}

          {/* Connect New button */}
          <Button
            onClick={handleConnectNew}
            disabled={status !== 'pending'}
            variant="outline"
            size="sm"
            className="border-blue-200 text-blue-700 hover:bg-blue-100"
          >
            {status === 'connecting' ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Plus className="h-4 w-4 mr-1" />
            )}
            Connect New Account
            <ExternalLink className="h-3 w-3 ml-1" />
          </Button>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleProvide}
              disabled={selectedAccountIds.size === 0 || status !== 'pending'}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">
                Grant Access{selectedAccountIds.size > 0 ? ` (${selectedAccountIds.size})` : ''}
              </span>
            </Button>

            <Button
              onClick={handleDecline}
              disabled={status !== 'pending'}
              variant="outline"
              size="sm"
              className="border-blue-200 text-blue-700 hover:bg-blue-100"
            >
              <X className="h-4 w-4" />
              <span className="ml-1">Decline</span>
            </Button>
          </div>

          {/* Error message */}
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* Info text */}
          <p className="text-xs text-blue-600">
            Selected accounts will be linked to this agent for future use.
          </p>
        </div>
      </div>
    </div>
  )
}

interface AccountOptionProps {
  account: ConnectedAccount
  selected: boolean
  onToggle: () => void
  disabled: boolean
}

function AccountOption({ account, selected, onToggle, disabled }: AccountOptionProps) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors',
        selected
          ? 'bg-blue-100 border-blue-300'
          : 'bg-white border-blue-100 hover:border-blue-200',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => !disabled && onToggle()}
        disabled={disabled}
      />
      <span className="flex-1 truncate">{account.displayName}</span>
      <span
        className={cn(
          'text-xs px-1.5 py-0.5 rounded',
          account.status === 'active'
            ? 'bg-green-100 text-green-700'
            : 'bg-red-100 text-red-700'
        )}
      >
        {account.status}
      </span>
    </label>
  )
}
