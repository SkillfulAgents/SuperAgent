import { apiFetch } from '@renderer/lib/api'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Link2,
  Check,
  X,
  Loader2,
  Plus,
  ExternalLink,
  Pencil,
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@shared/lib/utils/cn'
import {
  useConnectedAccountsByToolkit,
  useInvalidateConnectedAccounts,
  useRenameConnectedAccount,
  type ConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import { getProvider } from '@shared/lib/composio/providers'
import { formatDistanceToNow } from 'date-fns'

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
  const [editingAccount, setEditingAccount] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const { data, isLoading, refetch } = useConnectedAccountsByToolkit(toolkit)
  const invalidateConnectedAccounts = useInvalidateConnectedAccounts()
  const renameAccount = useRenameConnectedAccount()
  // Track account IDs before OAuth to detect new accounts
  const accountIdsBeforeOAuth = useRef<Set<string>>(new Set())

  const provider = getProvider(toolkit)
  const accounts = data?.accounts ?? []

  // Listen for OAuth callback messages (both IPC in Electron and postMessage in web)
  useEffect(() => {
    // Handle OAuth completion
    const handleOAuthComplete = async (success: boolean, errorMessage?: string, newAccountId?: string) => {
      if (success) {
        // Refresh the accounts list
        invalidateConnectedAccounts()
        const result = await refetch()
        setStatus('pending')

        // Auto-select the newly added account
        if (newAccountId) {
          // We have the new account ID directly
          setSelectedAccountIds((prev) => new Set(prev).add(newAccountId))
        } else if (result.data?.accounts) {
          // Find the new account by comparing with accounts before OAuth
          const newAccount = result.data.accounts.find(
            (acc) => !accountIdsBeforeOAuth.current.has(acc.id)
          )
          if (newAccount) {
            setSelectedAccountIds((prev) => new Set(prev).add(newAccount.id))
          }
        }
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
              const data = await res.json()
              handleOAuthComplete(true, undefined, data.account?.id)
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
        handleOAuthComplete(event.data.success, event.data.error, event.data.accountId)
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

    // Track current account IDs before OAuth to detect new account later
    accountIdsBeforeOAuth.current = new Set(accounts.map((a) => a.id))

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
                    isEditing={editingAccount === account.id}
                    editName={editName}
                    onStartEdit={() => {
                      setEditingAccount(account.id)
                      setEditName(account.displayName)
                    }}
                    onCancelEdit={() => {
                      setEditingAccount(null)
                      setEditName('')
                    }}
                    onSaveEdit={async () => {
                      if (!editName.trim()) return
                      try {
                        await renameAccount.mutateAsync({
                          accountId: account.id,
                          displayName: editName.trim(),
                        })
                        setEditingAccount(null)
                        setEditName('')
                      } catch (err) {
                        console.error('Failed to rename account:', err)
                      }
                    }}
                    onEditNameChange={setEditName}
                    isSavingRename={renameAccount.isPending}
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
  isEditing: boolean
  editName: string
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onEditNameChange: (value: string) => void
  isSavingRename: boolean
}

function AccountOption({
  account,
  selected,
  onToggle,
  disabled,
  isEditing,
  editName,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditNameChange,
  isSavingRename,
}: AccountOptionProps) {
  const connectedDate = new Date(account.createdAt)
  const connectedAgo = formatDistanceToNow(connectedDate, { addSuffix: true })

  if (isEditing) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 p-2 rounded border',
          'bg-white border-blue-200'
        )}
      >
        <Input
          value={editName}
          onChange={(e) => onEditNameChange(e.target.value)}
          className="h-7 text-sm flex-1"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveEdit()
            if (e.key === 'Escape') onCancelEdit()
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={onSaveEdit}
          disabled={isSavingRename}
        >
          {isSavingRename ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3 text-green-600" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={onCancelEdit}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors',
        selected
          ? 'bg-blue-100 border-blue-300'
          : 'bg-white border-blue-100 hover:border-blue-200',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
      onClick={() => !disabled && onToggle()}
    >
      <Checkbox
        checked={selected}
        disabled={disabled}
        onCheckedChange={() => {
          if (!disabled) onToggle()
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm">{account.displayName}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 w-5 p-0 shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              onStartEdit()
            }}
          >
            <Pencil className="h-3 w-3 text-blue-400" />
          </Button>
        </div>
        <span className="text-xs text-blue-500">connected {connectedAgo}</span>
      </div>
      <span
        className={cn(
          'text-xs px-1.5 py-0.5 rounded shrink-0',
          account.status === 'active'
            ? 'bg-green-100 text-green-700'
            : 'bg-red-100 text-red-700'
        )}
      >
        {account.status}
      </span>
    </div>
  )
}
