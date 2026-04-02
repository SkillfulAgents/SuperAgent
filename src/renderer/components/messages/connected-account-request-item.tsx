import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { formatDistanceToNow } from 'date-fns'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Check,
  X,
  Loader2,
  Plus,
  Pencil,
  MoreVertical,
  Plug,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { DeclineButton } from './decline-button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
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

  // Auto-select when there's exactly one account
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current) return
    if (accounts.length === 1 && selectedAccountIds.size === 0) {
      setSelectedAccountIds(new Set([accounts[0].id]))
      hasAutoSelected.current = true
    }
  }, [accounts, selectedAccountIds.size])

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
        // Only handle callbacks for this toolkit
        if (params.toolkit && params.toolkit !== toolkit) return

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
          } catch (error: unknown) {
            handleOAuthComplete(false, error instanceof Error ? error.message : 'OAuth completion failed')
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
  }, [invalidateConnectedAccounts, refetch, toolkit])

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
    } catch (err: unknown) {
      popup.close()
      setError(err instanceof Error ? err.message : 'Failed to connect account')
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to provide access')
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to decline request')
      setStatus('pending')
    }
  }

  // Build completed config
  const isCompleted = status === 'provided' || status === 'declined'
  const completedConfig = isCompleted
    ? {
        icon: (
          <ServiceIcon
            slug={toolkit}
            fallback="request"
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'provided' ? 'text-green-500' : 'text-red-500'
            )}
          />
        ),
        label: (
          <span className="font-medium capitalize">
            {provider?.displayName || toolkit}
          </span>
        ),
        statusLabel: status === 'provided' ? 'Access Granted' : 'Declined',
        isSuccess: status === 'provided',
      }
    : null

  // Build read-only config
  const readOnlyConfig = readOnly
    ? {
        description: reason ? (
          <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
        ) : undefined,
      }
    : (false as const)

  return (
    <RequestItemShell
      title="Account Access Request"
      icon={<Plug className="h-4 w-4" />}
      theme="blue"
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for response"
      error={error}
      data-testid={isCompleted ? 'connected-account-request-completed' : 'connected-account-request'}
      data-status={isCompleted ? status : undefined}
    >
      {/* Description */}
      {reason && (
        <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Selected accounts will be linked to this agent for future use.
      </p>

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
          <div className="flex items-center justify-between gap-3 rounded-[12px] border border-border bg-white pl-[10px] pr-3 py-2 dark:bg-background">
            <div className="flex items-center gap-2 text-sm text-foreground/80">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
                <ServiceIcon slug={toolkit} fallback="request" className="h-6 w-6" />
              </div>
              <p>{(provider?.displayName || toolkit).replace(/\b\w/g, (char) => char.toUpperCase())}</p>
            </div>
            <Button
              onClick={handleConnectNew}
              loading={status === 'connecting'}
              disabled={status !== 'pending'}
              size="sm"
              className="min-w-24 bg-foreground text-background hover:bg-foreground/90"
            >
              <Plus className="h-4 w-4" />
              Connect
            </Button>
          </div>
        </div>
      )}

      {/* Connect New button */}
      {accounts.length > 0 && (
        <div className="mt-1 ml-2">
          <Button
            onClick={handleConnectNew}
            loading={status === 'connecting'}
            disabled={status !== 'pending'}
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="mr-1 h-4 w-4" />
            Add New Account
          </Button>
        </div>
      )}

      {/* Action buttons when accounts exist */}
      {accounts.length > 0 && (
        <RequestItemActions className="pt-0">
          <DeclineButton
            onDecline={handleDecline}
            disabled={status !== 'pending'}
            label="Deny"
            showIcon={false}
            className="border-border text-foreground hover:bg-muted"
          />

          <Button
            onClick={handleProvide}
            loading={status === 'submitting'}
            disabled={selectedAccountIds.size === 0 || status !== 'pending'}
            size="sm"
            className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
          >
            Allow Access{selectedAccountIds.size > 0 ? ` (${selectedAccountIds.size})` : ''}
          </Button>
        </RequestItemActions>
      )}

      {/* Action buttons when no accounts */}
      {accounts.length === 0 && (
        <RequestItemActions className="mt-6 pt-0">
          <DeclineButton
            onDecline={handleDecline}
            disabled={status !== 'pending' && status !== 'connecting'}
            label="Deny"
            showIcon={false}
            className="border-border text-foreground hover:bg-muted"
          />
        </RequestItemActions>
      )}

      {/* Policy editor dialog */}
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
    </RequestItemShell>
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
  const connectedAgo = formatDistanceToNow(connectedDate, { addSuffix: true })
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
          loading={isSavingRename}
        >
          <Check className="h-3 w-3" />
          <span>Update</span>
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
        'group flex items-center gap-2 rounded-[12px] border pl-3 pr-4 py-2 cursor-pointer transition-colors',
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
      <input
        type="checkbox"
        checked={selected}
        disabled={disabled}
        onChange={() => !disabled && onToggle()}
        onClick={(e) => e.stopPropagation()}
        className="mx-1 shrink-0"
      />
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
