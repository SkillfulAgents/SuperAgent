import { apiFetch } from '@renderer/lib/api'

import { useState, useEffect } from 'react'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import {
  useConnectedAccounts,
  useInitiateConnection,
  useDeleteConnectedAccount,
  useRenameConnectedAccount,
  useInvalidateConnectedAccounts,
  type ConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import { Trash2, Loader2, Pencil, Check, X, Search } from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useQuery } from '@tanstack/react-query'
import type { Provider } from '@shared/lib/composio/providers'
import { formatDistanceToNow } from 'date-fns'

/**
 * Shared component for managing connected OAuth accounts.
 * Used in the onboarding wizard, Composio settings tab, and Accounts settings tab.
 */
export function ConnectedAccountsSection() {
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
  const [disconnectAccount, setDisconnectAccount] = useState<{ id: string; name: string } | null>(null)
  const [editingAccount, setEditingAccount] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [providerFilter, setProviderFilter] = useState('')

  // Listen for OAuth callback messages (both IPC in Electron and postMessage in web)
  useEffect(() => {
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
      const isElectronApp = !!window.electronAPI
      const result = await initiateConnection.mutateAsync({ providerSlug, electron: isElectronApp })

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

  const handleDelete = (account: ConnectedAccount) => {
    setDisconnectAccount({ id: account.id, name: account.displayName })
  }

  const handleConfirmDelete = async (accountId: string) => {
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
    <div className="space-y-4">
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
                    <ServiceIcon slug={account.toolkitSlug} fallback="oauth" className="h-4 w-4 text-primary" />
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
                    onClick={() => handleDelete(account)}
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
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter services..."
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {providers
            .filter((p) => {
              if (!providerFilter) return true
              const term = providerFilter.toLowerCase()
              return (
                p.displayName.toLowerCase().includes(term) ||
                p.slug.toLowerCase().includes(term) ||
                p.description.toLowerCase().includes(term)
              )
            })
            .map((provider) => (
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
                  <ServiceIcon slug={provider.slug} fallback="oauth" className="h-4 w-4 mr-2" />
                )}
                <HighlightMatch text={provider.displayName} query={providerFilter} />
              </Button>
            ))}
        </div>
      </div>

      {/* Disconnect confirmation dialog */}
      <AlertDialog open={!!disconnectAccount} onOpenChange={(open) => !open && setDisconnectAccount(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Account</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disconnect {disconnectAccount?.name}? This will remove the stored credentials.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (disconnectAccount) {
                  handleConfirmDelete(disconnectAccount.id)
                }
                setDisconnectAccount(null)
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>

  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>

  return (
    <span>
      {text.slice(0, idx)}
      <span className="bg-yellow-200 dark:bg-yellow-800 rounded-sm">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </span>
  )
}
