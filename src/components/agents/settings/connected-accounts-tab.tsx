'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Loader2, ExternalLink } from 'lucide-react'
import type { ConnectedAccount } from '@/lib/hooks/use-connected-accounts'
import type { Provider } from '@/lib/composio/providers'

interface AgentConnectedAccount extends ConnectedAccount {
  mappingId: string
  mappedAt: string
  provider?: Provider
}

interface AgentConnectedAccountsResponse {
  accounts: AgentConnectedAccount[]
}

interface ConnectedAccountsTabProps {
  agentId: string
}

export function ConnectedAccountsTab({ agentId }: ConnectedAccountsTabProps) {
  const queryClient = useQueryClient()
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set())
  const [isAdding, setIsAdding] = useState(false)

  // Fetch agent's connected accounts
  const { data: agentAccountsData, isLoading: isLoadingAgentAccounts } = useQuery<AgentConnectedAccountsResponse>({
    queryKey: ['agent-connected-accounts', agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/connected-accounts`)
      if (!res.ok) throw new Error('Failed to fetch agent connected accounts')
      return res.json()
    },
  })

  // Fetch all available connected accounts
  const { data: allAccountsData, isLoading: isLoadingAllAccounts } = useQuery<{ accounts: ConnectedAccount[] }>({
    queryKey: ['connected-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/connected-accounts')
      if (!res.ok) throw new Error('Failed to fetch connected accounts')
      return res.json()
    },
  })

  // Add accounts to agent
  const addAccounts = useMutation({
    mutationFn: async (accountIds: string[]) => {
      const res = await fetch(`/api/agents/${agentId}/connected-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds }),
      })
      if (!res.ok) throw new Error('Failed to add accounts')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts', agentId] })
      setSelectedAccounts(new Set())
      setIsAdding(false)
    },
  })

  // Remove account from agent
  const removeAccount = useMutation({
    mutationFn: async (accountId: string) => {
      const res = await fetch(`/api/agents/${agentId}/connected-accounts/${accountId}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Failed to remove account')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-connected-accounts', agentId] })
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
          {agentAccounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center justify-between p-3 rounded-md border bg-muted/30"
            >
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                  <ExternalLink className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium">{account.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {account.provider?.displayName || account.toolkitSlug}
                  </p>
                </div>
              </div>
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
            </div>
          ))}
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
              No more accounts available. Connect new accounts in Settings &gt; Composio.
            </p>
          ) : (
            <div className="space-y-2">
              {availableAccounts.map((account) => (
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
                      {account.toolkitSlug}
                    </p>
                  </label>
                </div>
              ))}
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
          No connected accounts available. Go to Settings &gt; Composio to connect accounts first.
        </p>
      )}
    </div>
  )
}
