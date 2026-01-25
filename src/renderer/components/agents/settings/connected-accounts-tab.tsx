import { apiFetch } from '@renderer/lib/api'

import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Loader2, ExternalLink, Pencil, Check, X } from 'lucide-react'
import { useRenameConnectedAccount, type ConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import type { Provider } from '@shared/lib/composio/providers'
import { formatDistanceToNow } from 'date-fns'

interface AgentConnectedAccount extends ConnectedAccount {
  mappingId: string
  mappedAt: string
  provider?: Provider
}

interface AgentConnectedAccountsResponse {
  accounts: AgentConnectedAccount[]
}

interface ConnectedAccountsTabProps {
  agentSlug: string
}

export function ConnectedAccountsTab({ agentSlug }: ConnectedAccountsTabProps) {
  const queryClient = useQueryClient()
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)
  const [editingAccount, setEditingAccount] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const renameAccount = useRenameConnectedAccount()

  // Fetch agent's connected accounts
  const { data: agentAccountsData, isLoading: isLoadingAgentAccounts } = useQuery<AgentConnectedAccountsResponse>({
    queryKey: ['agent-connected-accounts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/connected-accounts`)
      if (!res.ok) throw new Error('Failed to fetch agent connected accounts')
      return res.json()
    },
  })

  // Fetch all available connected accounts
  const { data: allAccountsData, isLoading: isLoadingAllAccounts } = useQuery<{ accounts: ConnectedAccount[] }>({
    queryKey: ['connected-accounts'],
    queryFn: async () => {
      const res = await apiFetch('/api/connected-accounts')
      if (!res.ok) throw new Error('Failed to fetch connected accounts')
      return res.json()
    },
  })

  // Add accounts to agent
  const addAccounts = useMutation({
    mutationFn: async (accountIds: string[]) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/connected-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds }),
      })
      if (!res.ok) throw new Error('Failed to add accounts')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts', agentSlug] })
      setSelectedAccounts(new Set())
      setIsAdding(false)
    },
  })

  // Remove account from agent
  const removeAccount = useMutation({
    mutationFn: async (accountId: string) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/connected-accounts/${accountId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to remove account')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts', agentSlug] })
    },
  })

  const agentAccounts = agentAccountsData?.accounts || []
  const allAccounts = allAccountsData?.accounts || []

  // Filter out accounts already assigned to this agent
  const assignedIds = new Set(agentAccounts.map((a) => a.id))
  const availableAccounts = allAccounts.filter((a) => !assignedIds.has(a.id))

  const handleToggleAccount = (accountId: string) => {
    setSelectedAccounts((prev) => {
      const next = new Set(prev)
      if (next.has(accountId)) {
        next.delete(accountId)
      } else {
        next.add(accountId)
      }
      return next
    })
  }

  const handleAddSelected = async () => {
    if (selectedAccounts.size === 0) return
    await addAccounts.mutateAsync(Array.from(selectedAccounts))
  }

  const handleRemove = async (accountId: string) => {
    await removeAccount.mutateAsync(accountId)
  }

  const handleStartRename = (account: AgentConnectedAccount) => {
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

  const isLoading = isLoadingAgentAccounts || isLoadingAllAccounts

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Connected Accounts</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Grant this agent access to your connected OAuth accounts.
        </p>
      </div>

      {/* Current agent accounts */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading accounts...
        </div>
      ) : agentAccounts.length > 0 ? (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Accounts this agent can access:</Label>
          {agentAccounts.map((account) => {
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
                          {account.provider?.displayName || account.toolkitSlug} · connected {connectedAgo}
                        </p>
                      </>
                    )}
                  </div>
                </div>
                {!isEditing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRemove(account.id)}
                    disabled={removeAccount.isPending}
                  >
                    {removeAccount.isPending ? (
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
        <p className="text-sm text-muted-foreground">
          No accounts assigned to this agent yet.
        </p>
      )}

      {/* Add accounts section */}
      {!isAdding ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsAdding(true)}
          disabled={availableAccounts.length === 0}
        >
          <Plus className="h-4 w-4 mr-2" />
          {availableAccounts.length === 0
            ? 'No accounts available'
            : 'Add accounts'}
        </Button>
      ) : (
        <div className="space-y-4 p-4 border rounded-md">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Select accounts to add:</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsAdding(false)
                setSelectedAccounts(new Set())
              }}
            >
              Cancel
            </Button>
          </div>

          {availableAccounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No more accounts available. Connect new accounts in Settings &gt; Accounts.
            </p>
          ) : (
            <div className="space-y-2">
              {availableAccounts.map((account) => {
                const connectedDate = new Date(account.createdAt)
                const connectedAgo = formatDistanceToNow(connectedDate, { addSuffix: true })
                return (
                  <div
                    key={account.id}
                    className="flex items-center space-x-3 p-2 rounded hover:bg-muted/50"
                  >
                    <Checkbox
                      id={`account-${account.id}`}
                      checked={selectedAccounts.has(account.id)}
                      onCheckedChange={() => handleToggleAccount(account.id)}
                    />
                    <label
                      htmlFor={`account-${account.id}`}
                      className="flex-1 cursor-pointer"
                    >
                      <p className="text-sm font-medium">{account.displayName}</p>
                      <p className="text-xs text-muted-foreground">
                        {account.toolkitSlug} · connected {connectedAgo}
                      </p>
                    </label>
                  </div>
                )
              })}
            </div>
          )}

          {selectedAccounts.size > 0 && (
            <Button
              size="sm"
              onClick={handleAddSelected}
              disabled={addAccounts.isPending}
            >
              {addAccounts.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                <>Add {selectedAccounts.size} account(s)</>
              )}
            </Button>
          )}
        </div>
      )}

      {allAccounts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No connected accounts available. Go to Settings &gt; Accounts to connect accounts first.
        </p>
      )}
    </div>
  )
}
