import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Check,
  X,
  Loader2,
  Plus,
  ExternalLink,
  Pencil,
  MoreVertical,
  Plug,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { DeclineButton } from './decline-button'
import { RequestTitleChip } from './request-title-chip'
import { cn } from '@shared/lib/utils/cn'
import { ScopePolicyEditor } from '@renderer/components/settings/scope-policy-editor'
import { PolicySummaryPill } from '@renderer/components/ui/policy-summary-pill'
import {
  useConnectedAccountsByToolkit,
  useInvalidateConnectedAccounts,
  useRenameConnectedAccount,
  type ConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import { getProvider } from '@shared/lib/composio/providers'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

interface ConnectedAccountRequestItemProps {
  toolUseId: string
  toolkit: string
  reason?: string
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined' | 'connecting'

function formatShortRelativeTime(date: Date) {
  const diffMs = Math.max(0, Date.now() - date.getTime())
  const minutes = Math.floor(diffMs / (1000 * 60))

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(days / 365)
  return `${years}y ago`
}

export function ConnectedAccountRequestItem({
  toolUseId,
  toolkit,
  reason,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: ConnectedAccountRequestItemProps) {
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [editingAccount, setEditingAccount] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [policyEditorAccountId, setPolicyEditorAccountId] = useState<string | null>(null)
  const [policyEditorIsNewAccount, setPolicyEditorIsNewAccount] = useState(false)
  const { data, isLoading, refetch } = useConnectedAccountsByToolkit(toolkit)
  const invalidateConnectedAccounts = useInvalidateConnectedAccounts()
  const renameAccount = useRenameConnectedAccount()
  // Track account IDs before OAuth to detect new accounts
  const accountIdsBeforeOAuth = useRef<Set<string>>(new Set())
  // Track whether this component instance initiated the OAuth flow
  const isOAuthInitiator = useRef(false)

  const { track } = useAnalyticsTracking()
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

        // Only auto-select the new account if this component initiated the OAuth flow
        if (isOAuthInitiator.current) {
          isOAuthInitiator.current = false
          let detectedNewAccountId = newAccountId
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
              detectedNewAccountId = newAccount.id
            }
          }
          // Open policy editor for the newly connected account
          if (detectedNewAccountId) {
            setPolicyEditorIsNewAccount(true)
            setPolicyEditorAccountId(detectedNewAccountId)
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
    track('account_added', { slug: toolkit, location: 'session' })

    // Track current account IDs before OAuth to detect new account later
    accountIdsBeforeOAuth.current = new Set(accounts.map((a) => a.id))
    isOAuthInitiator.current = true

    const popup = prepareOAuthPopup()

    try {
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
      await popup.navigate(redirectUrl)
      setStatus('pending')
    } catch (err: any) {
      popup.close()
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

  const handleDecline = async (reason?: string) => {
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
            declineReason: reason || 'User declined to provide access',
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-center gap-2 p-4">
          <ServiceIcon
            slug={toolkit}
            fallback="request"
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

  // Read-only state for viewers
  if (readOnly) {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 px-4 pb-4 pt-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip
              className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
              icon={<Plug className="h-4 w-4" />}
            >
              Account Access Request
            </RequestTitleChip>
            {reason && (
              <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
            )}
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting/connecting state
  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
      <div className="px-4 pb-4 pt-4">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <RequestTitleChip
                className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                icon={<Plug className="h-4 w-4" />}
              >
                Account Access Request
              </RequestTitleChip>
              {reason && (
                <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Selected accounts will be linked to this agent for future use.
              </p>
            </div>
          </div>

          {/* Account Selection */}
          {isLoading ? (
            <div className="flex items-center gap-2 pt-3 text-blue-600 dark:text-blue-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading accounts...</span>
            </div>
          ) : accounts.length > 0 ? (
            <div className="space-y-1 pt-3">
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
                    onOpenPolicies={() => {
                      setPolicyEditorIsNewAccount(false)
                      setPolicyEditorAccountId(account.id)
                    }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="pt-3">
              <div className="flex items-center justify-between gap-3 rounded-[12px] border border-border bg-white pl-[10px] pr-4 py-2 dark:bg-background">
                <div className="flex items-center gap-2 text-sm text-foreground/80">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
                    <ServiceIcon slug={toolkit} fallback="request" className="h-6 w-6" />
                  </div>
                  <p>{(provider?.displayName || toolkit).replace(/\b\w/g, (char) => char.toUpperCase())}</p>
                </div>
                <span className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-xs font-medium text-foreground/80">
                  not connected
                </span>
              </div>
            </div>
          )}

          {/* Connect New button */}
          {accounts.length > 0 && (
            <div className="!mt-1 ml-2">
              <Button
                onClick={handleConnectNew}
                disabled={status !== 'pending'}
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {status === 'connecting' ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-4 w-4" />
                )}
                Add New Account
              </Button>
            </div>
          )}

          {/* Action buttons */}
          {accounts.length > 0 && (
            <div className="flex justify-end gap-2">
              <DeclineButton
                onDecline={handleDecline}
                disabled={status !== 'pending'}
                label="Deny"
                showIcon={false}
                className="border-border text-foreground hover:bg-muted"
              />

              <Button
                onClick={handleProvide}
                disabled={selectedAccountIds.size === 0 || status !== 'pending'}
                size="sm"
              className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                  <span>Allow Access{selectedAccountIds.size > 0 ? ` (${selectedAccountIds.size})` : ''}</span>
              )}
              {status === 'submitting' ? (
                  <span className="ml-1">Allow Access{selectedAccountIds.size > 0 ? ` (${selectedAccountIds.size})` : ''}</span>
              ) : null}
            </Button>
            </div>
          )}

          {accounts.length === 0 && (
            <div className="mt-6">
              <div className="flex justify-end gap-2">
                <DeclineButton
                  onDecline={handleDecline}
                  disabled={status !== 'pending' && status !== 'connecting'}
                  label="Deny"
                  showIcon={false}
                  className="border-border text-foreground hover:bg-muted"
                />
                <Button
                  onClick={handleConnectNew}
                  disabled={status !== 'pending'}
                  size="sm"
                  className="min-w-24 bg-foreground text-background hover:bg-foreground/90"
                >
                  {status === 'connecting' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {status === 'connecting' ? (
                    <span className="ml-1">Connect</span>
                  ) : (
                    'Connect'
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
              Error: {error}
            </div>
          )}

        </div>
      </div>
      {policyEditorAccountId && (
        <ScopePolicyEditor
          accountId={policyEditorAccountId}
          toolkit={toolkit}
          open={!!policyEditorAccountId}
          onOpenChange={(open) => {
            if (!open) {
              setPolicyEditorAccountId(null)
              setPolicyEditorIsNewAccount(false)
            }
          }}
          header={policyEditorIsNewAccount ? (
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
                <ServiceIcon slug={toolkit} fallback="oauth" className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <div className="text-center">
                <p className="text-base font-semibold capitalize">
                  {provider?.displayName || toolkit} Successfully Connected!
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Configure what agents can do with this account.
                </p>
              </div>
            </div>
          ) : undefined}
        />
      )}
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
  onOpenPolicies: () => void
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
  onOpenPolicies,
}: AccountOptionProps) {
  const connectedDate = new Date(account.createdAt)
  const connectedAgo = formatShortRelativeTime(connectedDate)
  const [menuOpen, setMenuOpen] = useState(false)

  if (isEditing) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-[12px] border px-4 py-2',
          'border-border bg-white dark:bg-background'
        )}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
          <ServiceIcon slug={account.toolkitSlug} fallback="request" className="h-5 w-5" />
        </div>
        <Input
          value={editName}
          onChange={(e) => onEditNameChange(e.target.value)}
          className="h-7 max-w-[296px] flex-1 text-sm"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveEdit()
            if (e.key === 'Escape') onCancelEdit()
          }}
        />
        <Button
          size="sm"
          variant="default"
          className="h-6 shrink-0 bg-foreground px-2 text-xs text-background hover:bg-foreground/90"
          onClick={onSaveEdit}
          disabled={isSavingRename}
        >
          {isSavingRename ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <Check className="h-3 w-3" />
              <span>Update</span>
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={onCancelEdit}
        >
          <X className="h-3 w-3" />
          <span>Cancel</span>
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-[12px] border pl-4 pr-4 py-2 cursor-pointer transition-colors',
        selected
          ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40'
          : 'border-border bg-white hover:bg-muted/40 dark:bg-background',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
      role="button"
      tabIndex={0}
      onClick={() => !disabled && onToggle()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !disabled) {
          e.preventDefault()
          onToggle()
        }
      }}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
        <ServiceIcon slug={account.toolkitSlug} fallback="request" className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-normal text-foreground">{account.displayName}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">connected {connectedAgo}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-center">
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <span onClick={(e) => e.stopPropagation()}>
          <PolicySummaryPill
            accountId={account.id}
            toolkit={account.toolkitSlug}
            compact
            onClick={onOpenPolicies}
          />
        </span>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 shrink-0 p-0 text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation()
              }}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-32 p-1"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-start gap-2 text-foreground hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onStartEdit()
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </Button>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
