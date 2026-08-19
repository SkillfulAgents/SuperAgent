import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils'
import { Check, Loader2, Upload, X } from 'lucide-react'
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

interface AgentSharePopoverProps {
  agentSlug: string
}

const ROLE_OPTIONS: { value: AgentRole; label: string; description: string }[] = [
  { value: 'owner', label: 'Owner', description: 'Full control of this agent' },
  { value: 'user', label: 'User', description: 'Can start sessions and chat' },
  { value: 'viewer', label: 'Viewer', description: 'Can view sessions only' },
]

const ROLE_LABELS: Record<AgentRole, string> = Object.fromEntries(
  ROLE_OPTIONS.map((r) => [r.value, r.label])
) as Record<AgentRole, string>

/** Sentinel value for the "Remove" item in the per-row role dropdown. */
const REMOVE_SENTINEL = '__remove__'

/** Two-line role items (label + permission description) shared by both selects. */
function RoleSelectItems() {
  return (
    <>
      {ROLE_OPTIONS.map((role) => (
        <SelectItem key={role.value} value={role.value} className="pr-8">
          <div className="flex flex-col items-start gap-0.5">
            <span>{role.label}</span>
            <span className="text-xs text-muted-foreground">{role.description}</span>
          </div>
        </SelectItem>
      ))}
    </>
  )
}

function UserAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-muted font-medium uppercase text-muted-foreground ${className ?? 'h-7 w-7 text-xs'}`}
    >
      {name.charAt(0) || '?'}
    </div>
  )
}

/**
 * Share button + popover for managing per-user agent access (ACL).
 *
 * This is the agent Access UI, moved out of the settings dialog into a
 * Notion-style share popover on the agent header. Only rendered in auth mode
 * for agent owners — the /access endpoints are AgentAdmin()-guarded.
 */
export function AgentSharePopover({ agentSlug }: AgentSharePopoverProps) {
  const queryClient = useQueryClient()
  const { user } = useUser()
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [inviteRole, setInviteRole] = useState<AgentRole>('user')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const resetInvite = () => {
    setSelectedUsers([])
    setSearchQuery('')
    setInviteRole('user')
    setError(null)
  }

  const invalidateAccess = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-access', agentSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-invite-candidates', agentSlug] })
    queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
  }

  // Fetch access list (only while open — the popover is mounted with the header)
  const { data: accessList, isLoading } = useQuery<AccessEntry[]>({
    queryKey: ['agent-access', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access`)
      if (!res.ok) throw new Error('Failed to fetch access list')
      return res.json()
    },
    enabled: open,
  })

  // All invitable users (workspace members minus current access holders).
  // Teams are small, so we show everyone as suggestions and filter client-side.
  const { data: candidates } = useQuery<SearchUser[]>({
    queryKey: ['agent-invite-candidates', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/access/search-users`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: open,
  })

  // Invite the selected batch. Runs each grant individually so one failure
  // doesn't sink the rest; succeeded users leave the chip row, failures stay.
  const inviteUsers = useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ users, role }: { users: SearchUser[]; role: AgentRole }) => {
      const succeeded = new Set<string>()
      const failures: string[] = []
      for (const u of users) {
        const res = await apiFetch(`/api/agents/${agentSlug}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: u.id, role }),
        })
        if (res.ok) {
          succeeded.add(u.id)
        } else {
          const data = await res.json().catch(() => ({}))
          failures.push(`${u.name}: ${data.error || 'Failed to invite user'}`)
        }
      }
      return { succeeded, failures }
    },
    onMutate: () => setError(null),
    onSuccess: ({ succeeded, failures }) => {
      invalidateAccess()
      if (failures.length) {
        setSelectedUsers((prev) => prev.filter((u) => !succeeded.has(u.id)))
        setError(failures.join('; '))
      } else {
        resetInvite()
      }
    },
    onError: (err: Error) => setError(err.message),
  })

  // Change role
  const changeRole = useMutation({
    meta: { skipGlobalErrorToast: true },
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
    onSuccess: invalidateAccess,
    onError: (err: Error) => setError(err.message),
  })

  // Remove access
  const removeAccess = useMutation({
    meta: { skipGlobalErrorToast: true },
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
    onSuccess: invalidateAccess,
    onError: (err: Error) => setError(err.message),
  })

  const ownerCount = accessList?.filter((e) => e.role === 'owner').length ?? 0

  const selectedIds = new Set(selectedUsers.map((u) => u.id))
  const accessIds = new Set(accessList?.map((e) => e.userId) ?? [])
  const filter = searchQuery.trim().toLowerCase()
  // Candidates are already ACL-filtered server-side; re-filter here so the list
  // updates instantly after an invite (before the refetch lands).
  const suggested = (candidates ?? []).filter(
    (u) =>
      !accessIds.has(u.id) &&
      (!filter || u.name.toLowerCase().includes(filter) || u.email.toLowerCase().includes(filter))
  )

  // Access holders matching the typed query — the "Already shared with"
  // section while searching.
  const matchedAccess = filter
    ? (accessList ?? []).filter(
        (e) => e.userName.toLowerCase().includes(filter) || e.userEmail.toLowerCase().includes(filter)
      )
    : []

  const toggleUser = (u: SearchUser) => {
    setSelectedUsers((prev) =>
      prev.some((s) => s.id === u.id) ? prev.filter((s) => s.id !== u.id) : [...prev, u]
    )
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  // Shared by the default people list and the "Already shared with" section.
  const renderAccessEntry = (entry: AccessEntry) => {
    const isLastOwner = entry.role === 'owner' && ownerCount <= 1
    const isSelf = entry.userId === user?.id
    return (
      <div
        key={entry.userId}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
        data-testid={`access-entry-${entry.userId}`}
      >
        <UserAvatar name={entry.userName} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">
            {entry.userName}
            {isSelf && <span className="text-muted-foreground"> (You)</span>}
          </div>
          <div className="truncate text-xs text-muted-foreground">{entry.userEmail}</div>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                {/* Remove lives inside the role dropdown (Notion-style);
                    the sentinel value routes to the delete mutation. */}
                <Select
                  value={entry.role}
                  onValueChange={(role) => {
                    if (role === REMOVE_SENTINEL) {
                      removeAccess.mutate(entry.userId)
                    } else {
                      changeRole.mutate({ userId: entry.userId, role: role as AgentRole })
                    }
                  }}
                  disabled={isLastOwner}
                >
                  <SelectTrigger
                    className="h-7 w-auto shrink-0 gap-1 border-none bg-transparent px-1.5 text-xs text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid={`access-role-${entry.userId}`}
                  >
                    <SelectValue>{ROLE_LABELS[entry.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end" className="w-64">
                    <RoleSelectItems />
                    <SelectSeparator />
                    <SelectItem
                      value={REMOVE_SENTINEL}
                      className="pr-8 text-destructive focus:text-destructive"
                      data-testid={`access-remove-${entry.userId}`}
                    >
                      Remove
                    </SelectItem>
                  </SelectContent>
                </Select>
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
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetInvite()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1"
          aria-label="Share agent"
          data-testid="agent-share-button"
        >
          <Upload className="h-3 w-3" />
          Share
        </Button>
      </PopoverTrigger>
      {/* 28rem = 448px, the `md` token — nearest to the 456px design width */}
      <PopoverContent
        align="end"
        className="w-[28rem] max-w-[calc(100vw-2rem)] p-0"
        // Radix's FocusScope would focus the content wrapper; send focus
        // straight to the invite input instead.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Defer past Radix's FocusScope so it can't reclaim focus after us.
          setTimeout(() => searchInputRef.current?.focus(), 0)
        }}
        data-testid="agent-share-popover"
      >
        {/* Invite row: chip box + batch role + Share */}
        <div className="space-y-2 p-3">
          <div className="flex items-start gap-2">
            {/* label: clicking anywhere in the chip box natively focuses the input.
                The role select sits inside the box, pinned top-right (Notion-style). */}
            <label className="flex min-h-8 min-w-0 flex-1 cursor-text items-start gap-1 rounded-md border bg-transparent px-1.5 py-1 has-[input:focus]:border-primary has-[input:focus]:ring-1 has-[input:focus]:ring-primary">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {selectedUsers.map((u) => (
                  <span
                    key={u.id}
                    className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-sm"
                    data-testid={`invite-chip-${u.id}`}
                  >
                    <UserAvatar name={u.name} className="h-4 w-4 text-[10px]" />
                    <span className="max-w-32 truncate">{u.name}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedUsers((prev) => prev.filter((s) => s.id !== u.id))
                      }}
                      aria-label={`Remove ${u.name} from invite`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  ref={searchInputRef}
                  placeholder={selectedUsers.length ? '' : 'Invite by name or email...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && !searchQuery && selectedUsers.length) {
                      setSelectedUsers((prev) => prev.slice(0, -1))
                    }
                  }}
                  className="h-6 min-w-20 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
                  data-testid="invite-search-input"
                />
              </div>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as AgentRole)}>
                <SelectTrigger
                  className="h-6 w-auto shrink-0 gap-1 border-none bg-transparent px-1 text-sm text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
                  data-testid="invite-role-select"
                >
                  <SelectValue>{ROLE_LABELS[inviteRole]}</SelectValue>
                </SelectTrigger>
                <SelectContent align="end" className="w-64">
                  <RoleSelectItems />
                </SelectContent>
              </Select>
            </label>
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={() => {
                if (inviteUsers.isPending) return
                // No disabled state: with nothing selected, just refocus the input
                if (!selectedUsers.length) {
                  searchInputRef.current?.focus()
                  return
                }
                inviteUsers.mutate({ users: selectedUsers, role: inviteRole })
              }}
              data-testid="invite-add-button"
            >
              {inviteUsers.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Share'}
            </Button>
          </div>

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}
        </div>

        {/* People list. While typing it becomes two filtered sections,
            Notion-style: access holders ("Already shared with") and
            invitable candidates ("Not shared with"). */}
        <div className="max-h-72 overflow-y-auto p-1.5">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filter ? (
            <>
              {matchedAccess.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">
                    Already shared with
                  </p>
                  {matchedAccess.map(renderAccessEntry)}
                </>
              )}
              {suggested.length > 0 && (
                <>
                  <p className={cn('px-2 pb-1 pt-0.5 text-xs text-muted-foreground', matchedAccess.length > 0 && 'pt-2')}>
                    Not shared with
                  </p>
                  {suggested.map((u) => {
                    const isSelected = selectedIds.has(u.id)
                    return (
                      <button
                        key={u.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                        onClick={() => toggleUser(u)}
                        role="checkbox"
                        aria-checked={isSelected}
                        data-testid={`invite-user-result-${u.id}`}
                      >
                        <UserAvatar name={u.name} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{u.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                        </div>
                        {/* Visual-only checkbox (the row is the control) — mirrors ui/checkbox */}
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary shadow',
                            isSelected && 'bg-primary text-primary-foreground'
                          )}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </span>
                      </button>
                    )
                  })}
                </>
              )}
              {matchedAccess.length === 0 && suggested.length === 0 && (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No users found
                </div>
              )}
            </>
          ) : !accessList?.length ? (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              No users have access to this agent.
            </div>
          ) : (
            accessList.map(renderAccessEntry)
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
