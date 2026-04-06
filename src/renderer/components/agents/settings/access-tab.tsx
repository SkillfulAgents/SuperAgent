import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { Loader2, Plus, Trash2, UserPlus, X } from 'lucide-react'
import type { AgentRole } from '@shared/lib/types/agent'

interface AccessEntry {
  userId: string
  role: AgentRole
  createdAt: string
  userName: string
  userEmail: string
}

interface SearchUser {
  id: string
  name: string
  email: string
}

interface AccessTabProps {
  agentSlug: string
}

export function AccessTab({ agentSlug }: AccessTabProps) {
  const queryClient = useQueryClient()
  const [isInviting, setIsInviting] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])
  const [selectedUser, setSelectedUser] = useState<SearchUser | null>(null)
  const [inviteRole, setInviteRole] = useState<AgentRole>('user')

  // Fetch access list
  const { data: accessList, isLoading } = useQuery<AccessEntry[]>({
    queryKey: ['agent-access', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access`)
      if (!res.ok) throw new Error('Failed to fetch access list')
      return res.json()
    },
  })

  // Search users
  const { data: searchResults } = useQuery<SearchUser[]>({
    queryKey: ['search-users', agentSlug, debouncedQuery],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access/search-users?q=${encodeURIComponent(debouncedQuery)}`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: debouncedQuery.length >= 2,
  })

  // Invite user
  const inviteUser = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AgentRole }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to invite user')
      }
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-access', agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
      setIsInviting(false)
      setSelectedUser(null)
      setSearchQuery('')
      setInviteRole('user')
    },
    onError: (err: Error) => setError(err.message),
  })

  // Change role
  const changeRole = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AgentRole }) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to change role')
      }
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-access', agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
    onError: (err: Error) => setError(err.message),
  })

  // Remove access
  const removeAccess = useMutation({
    mutationFn: async (userId: string) => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access/${userId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to remove access')
      }
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-access', agentSlug] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    },
    onError: (err: Error) => setError(err.message),
  })

  const ownerCount = accessList?.filter((e) => e.role === 'owner').length ?? 0

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Manage who has access to this agent and their permissions.
        </p>
        <Button size="sm" variant="outline" onClick={() => setIsInviting(true)} className={isInviting ? 'invisible' : ''} data-testid="invite-user-button">
          <UserPlus className="h-4 w-4 mr-1" />
          Invite
        </Button>
      </div>

      {error && (
        <div className="text-sm text-destructive px-1">{error}</div>
      )}

      {/* Invite form */}
      {isInviting && (
        <div className="border rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Invite User</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIsInviting(false)
                setSelectedUser(null)
                setSearchQuery('')
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {!selectedUser ? (
            <div className="space-y-2">
              <Input
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
                data-testid="invite-search-input"
              />
              {searchResults && searchResults.length > 0 && (
                <div className="border rounded-md max-h-32 overflow-y-auto">
                  {searchResults.map((user) => (
                    <button
                      key={user.id}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-accent flex items-center justify-between"
                      onClick={() => setSelectedUser(user)}
                      data-testid={`invite-user-result-${user.id}`}
                    >
                      <span>{user.name}</span>
                      <span className="text-muted-foreground text-xs">{user.email}</span>
                    </button>
                  ))}
                </div>
              )}
              {debouncedQuery.length >= 2 && searchResults?.length === 0 && (
                <p className="text-xs text-muted-foreground">No users found</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span>{selectedUser.name}</span>
                <span className="text-muted-foreground text-xs">({selectedUser.email})</span>
                <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => setSelectedUser(null)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as AgentRole)}>
                  <SelectTrigger className="w-32" data-testid="invite-role-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="owner">Owner</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={() => inviteUser.mutate({ userId: selectedUser.id, role: inviteRole })}
                  disabled={inviteUser.isPending}
                  data-testid="invite-add-button"
                >
                  {inviteUser.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Access list */}
      <div className="border rounded-lg divide-y">
        {!accessList?.length ? (
          <div className="px-3 py-4 text-sm text-muted-foreground text-center">
            No users have access to this agent.
          </div>
        ) : (
          accessList.map((entry) => {
            const isLastOwner = entry.role === 'owner' && ownerCount <= 1
            return (
              <div key={entry.userId} className="flex items-center justify-between px-3 py-2" data-testid={`access-entry-${entry.userId}`}>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{entry.userName}</div>
                  <div className="text-xs text-muted-foreground truncate">{entry.userEmail}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Select
                    value={entry.role}
                    onValueChange={(role) => changeRole.mutate({ userId: entry.userId, role: role as AgentRole })}
                    disabled={isLastOwner}
                  >
                    <SelectTrigger className="w-24 h-8 text-xs" data-testid={`access-role-${entry.userId}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="owner">Owner</SelectItem>
                    </SelectContent>
                  </Select>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => removeAccess.mutate(entry.userId)}
                            disabled={isLastOwner || removeAccess.isPending}
                            data-testid={`access-remove-${entry.userId}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {isLastOwner && (
                        <TooltipContent>
                          Cannot remove the last owner
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
