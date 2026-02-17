import { apiFetch } from '@renderer/lib/api'

import { useState, useEffect } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import {
  useConnectedAccounts,
  useInitiateConnection,
  useDeleteConnectedAccount,
  useRenameConnectedAccount,
  useInvalidateConnectedAccounts,
  type ConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import { Eye, EyeOff, Plus, Trash2, ExternalLink, Loader2, Pencil, Check, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Provider } from '@shared/lib/composio/providers'
import { formatDistanceToNow } from 'date-fns'

export function ComposioTab() {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()

  // Composio settings state
  const [composioApiKeyInput, setComposioApiKeyInput] = useState('')
  const [showComposioApiKey, setShowComposioApiKey] = useState(false)
  const [composioUserIdInput, setComposioUserIdInput] = useState('')
  const [isSavingComposio, setIsSavingComposio] = useState(false)

  const composioApiKeyStatus = settings?.apiKeyStatus?.composio
  const hasComposioUserId = !!settings?.composioUserId

  const handleSaveComposioSettings = async () => {
    setIsSavingComposio(true)
    try {
      const updates: { composioApiKey?: string; composioUserId?: string } = {}
      if (composioApiKeyInput.trim()) {
        updates.composioApiKey = composioApiKeyInput.trim()
      }
      if (composioUserIdInput.trim()) {
        updates.composioUserId = composioUserIdInput.trim()
      }
      if (Object.keys(updates).length > 0) {
        await updateSettings.mutateAsync({
          apiKeys: updates,
        })
        setComposioApiKeyInput('')
        setComposioUserIdInput('')
        setShowComposioApiKey(false)
      }
    } catch (error) {
      console.error('Failed to save Composio settings:', error)
    } finally {
      setIsSavingComposio(false)
    }
  }

  const handleRemoveComposioApiKey = async () => {
    setIsSavingComposio(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioApiKey: '' },
      })
    } catch (error) {
      console.error('Failed to remove Composio API key:', error)
    } finally {
      setIsSavingComposio(false)
    }
  }

  const handleRemoveComposioUserId = async () => {
    setIsSavingComposio(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { composioUserId: '' },
      })
    } catch (error) {
      console.error('Failed to remove Composio user ID:', error)
    } finally {
      setIsSavingComposio(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Composio Integration</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Connect external OAuth accounts (Gmail, Slack, GitHub, etc.) via Composio.
        </p>
      </div>

      {/* Composio API Key */}
      <div className="space-y-2">
        <Label htmlFor="composio-api-key">Composio API Key</Label>

        {/* Source indicator */}
        {composioApiKeyStatus?.isConfigured && (
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                composioApiKeyStatus.source === 'settings'
                  ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                  : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
              }`}
            >
              {composioApiKeyStatus.source === 'settings'
                ? 'Using saved setting'
                : 'Using environment variable'}
            </span>
          </div>
        )}

        {/* Input with show/hide toggle */}
        <div className="relative">
          <Input
            id="composio-api-key"
            type={showComposioApiKey ? 'text' : 'password'}
            value={composioApiKeyInput}
            onChange={(e) => setComposioApiKeyInput(e.target.value)}
            placeholder={composioApiKeyStatus?.isConfigured ? '••••••••••••••••' : 'Enter Composio API key'}
            className="pr-10"
            disabled={isLoading}
          />
          <button
            type="button"
            onClick={() => setShowComposioApiKey(!showComposioApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            disabled={isLoading}
          >
            {showComposioApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          Get your API key from{' '}
          <a
            href="https://app.composio.dev/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            Composio Dashboard
          </a>
        </p>

        {/* Remove button */}
        {composioApiKeyStatus?.source === 'settings' && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveComposioApiKey}
            disabled={isSavingComposio}
          >
            {isSavingComposio ? 'Removing...' : 'Remove Saved Key'}
          </Button>
        )}
      </div>

      {/* Composio User ID */}
      <div className="space-y-2">
        <Label htmlFor="composio-user-id">Composio User ID</Label>

        {/* Current value indicator */}
        {hasComposioUserId && (
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
              Configured
            </span>
          </div>
        )}

        <Input
          id="composio-user-id"
          type="text"
          value={composioUserIdInput}
          onChange={(e) => setComposioUserIdInput(e.target.value)}
          placeholder={hasComposioUserId ? 'Enter new user ID to replace' : 'Enter your Composio user ID'}
          disabled={isLoading}
        />

        <p className="text-xs text-muted-foreground">
          Your unique identifier in Composio. Can be any string (e.g., your email).
        </p>

        {/* Remove button */}
        {hasComposioUserId && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRemoveComposioUserId}
            disabled={isSavingComposio}
          >
            {isSavingComposio ? 'Removing...' : 'Remove User ID'}
          </Button>
        )}
      </div>

      {/* Save button for Composio settings */}
      {(composioApiKeyInput.trim() || composioUserIdInput.trim()) && (
        <Button size="sm" onClick={handleSaveComposioSettings} disabled={isSavingComposio}>
          {isSavingComposio ? 'Saving...' : 'Save Composio Settings'}
        </Button>
      )}

      {/* Connected Accounts Section - only show if Composio is configured */}
      {composioApiKeyStatus?.isConfigured && hasComposioUserId && (
        <ConnectedAccountsSection />
      )}
    </div>
  )
}

/**
 * Section for managing connected OAuth accounts
 */
function ConnectedAccountsSection() {
  const { data: accountsData, isLoading: isLoadingAccounts } = useConnectedAccounts()
  const { data: providersData } = useQuery<{ providers: Provider[] }>({
    queryKey: ['providers'],
    queryFn: async () => {
      const res = await apiFetch('/api/providers')
      if (!res.ok) throw new Error('Failed to fetch providers')
      return res.json()
    },
  })
  const initiateConnection = useInitiateConnection()
  const deleteAccount = useDeleteConnectedAccount()
  const renameAccount = useRenameConnectedAccount()
  const invalidateAccounts = useInvalidateConnectedAccounts()

  const [connectingProvider, setConnectingProvider] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [deletingAccount, setDeletingAccount] = useState<string | null>(null)
  const [editingAccount, setEditingAccount] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  // Listen for OAuth callback messages (both IPC in Electron and postMessage in web)
  useEffect(() => {
    // Handle OAuth completion
    const handleOAuthComplete = (success: boolean) => {
      setConnectingProvider(null)
      if (success) {
        invalidateAccounts()
      }
    }

    // Electron: use IPC callback with structured params
    if (window.electronAPI) {
      window.electronAPI.onOAuthCallback(async (params) => {
        if (params.error || params.status === 'failed') {
          console.error('OAuth failed:', params.error)
          handleOAuthComplete(false)
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
            handleOAuthComplete(res.ok)
          } catch (error) {
            console.error('Failed to complete OAuth:', error)
            handleOAuthComplete(false)
          }
        } else {
          handleOAuthComplete(false)
        }
      })
      return () => {
        window.electronAPI?.removeOAuthCallback()
      }
    }

    // Web: use postMessage from OAuth popup
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        handleOAuthComplete(event.data.success)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [invalidateAccounts])

  const handleConnect = async (providerSlug: string) => {
    setConnectingProvider(providerSlug)
    setConnectionError(null)
    try {
      // Pass electron flag to get correct callback URL
      const isElectronApp = !!window.electronAPI
      const result = await initiateConnection.mutateAsync({ providerSlug, electron: isElectronApp })

      // Open OAuth in system browser (Electron) or new tab (web)
      if (window.electronAPI) {
        await window.electronAPI.openExternal(result.redirectUrl)
      } else {
        window.open(result.redirectUrl, '_blank')
      }
    } catch (error: any) {
      console.error('Failed to initiate connection:', error)
      setConnectionError(error.message || 'Failed to connect. Please try again.')
      setConnectingProvider(null)
    }
  }

  const handleDelete = async (accountId: string) => {
    if (!confirm('Are you sure you want to disconnect this account?')) return

    setDeletingAccount(accountId)
    try {
      await deleteAccount.mutateAsync(accountId)
    } catch (error) {
      console.error('Failed to delete account:', error)
    } finally {
      setDeletingAccount(null)
    }
  }

  const handleStartRename = (account: ConnectedAccount) => {
    setEditingAccount(account.id)
    setEditName(account.displayName)
  }

  const handleCancelRename = () => {
    setEditingAccount(null)
    setEditName('')
  }

  const handleSaveRename = async (accountId: string) => {
    if (!editName.trim()) return
    try {
      await renameAccount.mutateAsync({ accountId, displayName: editName.trim() })
      setEditingAccount(null)
      setEditName('')
    } catch (error) {
      console.error('Failed to rename account:', error)
    }
  }

  const accounts = accountsData?.accounts || []
  const providers = providersData?.providers || []

  return (
    <div className="space-y-4 pt-4 border-t">
      <div>
        <h3 className="text-sm font-medium">Connected Accounts</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Manage your OAuth connections to external services.
        </p>
      </div>

      {/* Existing accounts list */}
      {isLoadingAccounts ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading accounts...
        </div>
      ) : accounts.length > 0 ? (
        <div className="space-y-2">
          {accounts.map((account) => {
            const provider = providers.find((p) => p.slug === account.toolkitSlug)
            const isEditing = editingAccount === account.id
            const connectedDate = new Date(account.createdAt)
            const connectedAgo = formatDistanceToNow(connectedDate, { addSuffix: true })
            return (
              <div
                key={account.id}
                className="flex items-center justify-between p-3 rounded-md border bg-muted/30"
              >
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <ExternalLink className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="h-7 text-sm"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename(account.id)
                            if (e.key === 'Escape') handleCancelRename()
                          }}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={() => handleSaveRename(account.id)}
                          disabled={renameAccount.isPending}
                        >
                          {renameAccount.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Check className="h-3 w-3 text-green-600" />
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={handleCancelRename}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{account.displayName}</p>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0"
                            onClick={() => handleStartRename(account)}
                          >
                            <Pencil className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {provider?.displayName || account.toolkitSlug} · connected {connectedAgo}
                        </p>
                      </>
                    )}
                  </div>
                </div>
                {!isEditing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(account.id)}
                    disabled={deletingAccount === account.id}
                  >
                    {deletingAccount === account.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 text-destructive" />
                    )}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
      )}

      {/* Connection error */}
      {connectionError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{connectionError}</p>
        </div>
      )}

      {/* Connect new account */}
      <div className="space-y-2">
        <Label>Connect a new account</Label>
        <div className="grid grid-cols-2 gap-2">
          {providers.map((provider) => (
            <Button
              key={provider.slug}
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => handleConnect(provider.slug)}
              disabled={connectingProvider !== null}
            >
              {connectingProvider === provider.slug ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              {provider.displayName}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
