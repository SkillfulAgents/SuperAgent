import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
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
import {
  useAgentTemplateStatus,
  useExportAgentTemplate,
  useExportAgentFull,
} from '@renderer/hooks/use-agent-templates'
import { AgentTemplatePublishPanel } from '@renderer/components/agents/agent-template-publish-panel'
import { ActivityOrb } from '@renderer/components/messages/activity-orb'
import { ArrowDownToLine, ArrowRight, Check, LibraryBig, Loader2, Lock, Upload, User, X } from 'lucide-react'
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
  agentName: string
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
        <SelectItem key={role.value} value={role.value} className="pr-8 text-sm">
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
 * Share button + popover for the agent header, with two Notion-style panes:
 * Share (per-user ACL, auth mode only — the /access endpoints are
 * AgentAdmin()-guarded) and Publish (template export + skillset publishing,
 * moved here from the settings General tab). Rendered for agent owners; in
 * non-auth deployments everyone is an owner and only Publish shows.
 */
export function AgentSharePopover({ agentSlug, agentName }: AgentSharePopoverProps) {
  const queryClient = useQueryClient()
  const { user, isAuthMode } = useUser()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'share' | 'publish' | 'export'>(isAuthMode ? 'share' : 'publish')
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [inviteRole, setInviteRole] = useState<AgentRole>('user')
  const [publishFlowOpen, setPublishFlowOpen] = useState(false)
  const [exportChoice, setExportChoice] = useState<'template' | 'full'>('template')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Publish pane data/mutations. Status only fetches once the popover opens.
  const { data: templateStatus } = useAgentTemplateStatus(open ? agentSlug : null)
  const exportTemplate = useExportAgentTemplate()
  const exportFull = useExportAgentFull()
  const exportPending = exportTemplate.isPending || exportFull.isPending
  const canPublish = templateStatus?.type === 'local' && templateStatus.publishable !== false

  const resetInvite = () => {
    setSelectedUsers([])
    setSearchQuery('')
    setInviteRole('user')
    setError(null)
    // Closing the popover also abandons an in-progress publish flow and
    // returns to the default tab and export choice, so reopening always
    // lands on Share with the invite input focused.
    setPublishFlowOpen(false)
    setExportChoice('template')
    setTab(isAuthMode ? 'share' : 'publish')
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
    enabled: open && isAuthMode,
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
    enabled: open && isAuthMode,
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
                    className="h-7 w-auto shrink-0 gap-1 border-none bg-transparent px-1.5 text-sm text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid={`access-role-${entry.userId}`}
                  >
                    <SelectValue>{ROLE_LABELS[entry.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end" className="w-64">
                    <RoleSelectItems />
                    <SelectSeparator />
                    <SelectItem
                      value={REMOVE_SENTINEL}
                      className="pr-8 text-sm text-destructive focus:text-destructive"
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
        // straight to the invite input instead (Share pane only).
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // Defer past Radix's FocusScope so it can't reclaim focus after us.
          if (isAuthMode && tab === 'share') {
            setTimeout(() => searchInputRef.current?.focus(), 0)
          }
        }}
        data-testid="agent-share-popover"
      >
        {/* Tab bar — Share only exists in auth mode (no ACL without auth).
            The publish flow replaces it with its own back navigation. Same
            segmented Tabs control as the connection directory's APIs/MCPs. */}
        {!(tab === 'publish' && publishFlowOpen) && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <div className="border-b p-2">
              <TabsList className="h-8">
                {([
                  ...(isAuthMode ? [{ id: 'share', label: 'Share' } as const] : []),
                  { id: 'publish', label: 'Publish' } as const,
                  { id: 'export', label: 'Export' } as const,
                ]).map((t) => (
                  <TabsTrigger
                    key={t.id}
                    value={t.id}
                    className="px-2.5 text-xs"
                    data-testid={`agent-share-tab-${t.id}`}
                  >
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
        )}

        {tab === 'publish' && (
          /* ── Publish pane: skillset publishing, flow inline in the popover ── */
          publishFlowOpen ? (
            <AgentTemplatePublishPanel
              agentSlug={agentSlug}
              onBack={() => setPublishFlowOpen(false)}
            />
          ) : (
            <div className="p-4" data-testid="agent-publish-pane">
              {canPublish ? (
                <div className="space-y-4">
                  {/* Hero (Notion "Publish to web"-style) */}
                  <div className="space-y-1 pt-2 text-center">
                    <p className="text-base font-medium">Publish to a Library</p>
                    <p className="text-sm text-muted-foreground">
                      Libraries are shared collections of agent templates and
                      skills. Publish this agent so teammates can install their
                      own copy.
                    </p>
                  </div>

                  {/* Diagram: the agent card rises to the cloud library, which
                      fans out to clustered teammates ready to run their copy. */}
                  {/* Fixed 416x224 coordinate system: user centers sit on a
                      75px radius around the cloud center (208,116) at 0° and
                      ±50°/±95° from vertical, so all five are equidistant. */}
                  <div className="relative h-60 overflow-hidden rounded-lg bg-gradient-to-b from-muted/70 to-transparent" aria-hidden="true">
                    {/* Dashed arrows: pill → cloud, cloud → each teammate.
                        Painted first so the circles sit on top. */}
                    <svg className="absolute inset-0 h-full w-full text-[#0099FF]" viewBox="0 0 416 240" preserveAspectRatio="none">
                      <defs>
                        {/* Open chevron head, lucide-arrow style */}
                        <marker
                          id="publish-diagram-arrow"
                          viewBox="0 0 10 10"
                          refX="7"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path
                            d="M2.5,1.5 L7.5,5 L2.5,8.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </marker>
                      </defs>
                      {([
                        // [x1, y1, x2, y2, arrowhead] — only the card→library
                        // line keeps its head; the radial spokes are plain.
                        [208, 168, 208, 147, true], // agent card up to the library
                        [208, 86, 208, 65, false], // library → top teammate
                        [185, 97, 169, 83, false], // library → upper-left
                        [231, 97, 247, 83, false], // library → upper-right
                        [178, 119, 157, 120, false], // library → lower-left
                        [238, 119, 259, 120, false], // library → lower-right
                      ] as const).map(([x1, y1, x2, y2, arrowhead]) => (
                        <line
                          key={`${x1}-${y1}`}
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="currentColor"
                          strokeOpacity="0.55"
                          strokeWidth="1.5"
                          strokeDasharray="3 4"
                          markerEnd={arrowhead ? 'url(#publish-diagram-arrow)' : undefined}
                        />
                      ))}
                    </svg>

                    {/* Teammates, all 75px from the library center (5th on top) */}
                    <div className="absolute left-1/2 top-[23px] flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border bg-background shadow-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="absolute left-[calc(50%-76px)] top-[50px] flex h-9 w-9 items-center justify-center rounded-full border bg-background shadow-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="absolute left-[calc(50%+40px)] top-[50px] flex h-9 w-9 items-center justify-center rounded-full border bg-background shadow-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="absolute left-[calc(50%-93px)] top-[105px] flex h-9 w-9 items-center justify-center rounded-full border bg-background shadow-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="absolute left-[calc(50%+57px)] top-[105px] flex h-9 w-9 items-center justify-center rounded-full border bg-background shadow-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>

                    {/* The library in the cloud */}
                    <div className="absolute left-1/2 top-[92px] flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full border border-[#0099FF]/30 bg-[#0099FF]/10">
                      <LibraryBig className="h-5 w-5 text-[#0099FF]" />
                    </div>

                    {/* The agent, Manus-pill style */}
                    <div className="absolute bottom-4 left-1/2 flex w-max max-w-[75%] -translate-x-1/2 items-center gap-2.5 rounded-xl border bg-background py-3 pl-4 pr-6 shadow-sm">
                      {/* The activity card's thought orb as the agent's avatar */}
                      <div className="shrink-0">
                        <ActivityOrb state="working" size={28} />
                      </div>
                      <p className="min-w-0 truncate text-sm font-medium">{agentName}</p>
                    </div>
                  </div>

                  <Button
                    className="w-full gap-1.5"
                    onClick={() => setPublishFlowOpen(true)}
                    data-testid="publish-skillset-button"
                  >
                    Publish
                    <ArrowRight className="h-4 w-4" />
                  </Button>

                  {/* What publishing to a library actually means */}
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <p className="flex items-start gap-2">
                      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Agent only published as template. Secrets &amp; session
                      data are excluded.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  Publishing isn&apos;t available — this agent is already linked to a
                  library or can&apos;t be republished from this workspace.
                </p>
              )}
            </div>
          )
        )}

        {tab === 'export' && (
          /* ── Export pane: template + full-agent downloads ── */
          <div className="space-y-3 p-3" data-testid="agent-export-pane">
            <div role="radiogroup" aria-label="Export type" className="space-y-1">
              {([
                {
                  id: 'template',
                  title: 'Agent Template',
                  description: 'Export a shareable template — no secrets or session data',
                },
                {
                  id: 'full',
                  title: 'Full Agent',
                  description: 'Export all data including sessions and keys. Share cautiously.',
                },
              ] as const).map((option) => {
                const isSelected = exportChoice === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
                    onClick={() => setExportChoice(option.id)}
                    data-testid={`export-option-${option.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{option.title}</p>
                      <p className="text-xs text-muted-foreground">{option.description}</p>
                    </div>
                    {isSelected ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : (
                      <span className="h-4 w-4 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
            <Button
              className="w-full gap-1.5"
              onClick={() => {
                if (exportPending) return
                if (exportChoice === 'template') {
                  exportTemplate.mutate({ agentSlug, agentName })
                } else {
                  exportFull.mutate({ agentSlug, agentName })
                }
              }}
              data-testid="export-submit-button"
            >
              {exportPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <ArrowDownToLine className="h-4 w-4" />
                  Export
                </>
              )}
            </Button>
          </div>
        )}

        {tab === 'share' && (
          <>
        {/* Invite row: chip box + batch role + Add */}
        <div className="space-y-2 p-3">
          <div className="flex items-start gap-2">
            {/* label: clicking anywhere in the chip box natively focuses the input.
                The role select sits inside the box, pinned top-right (Notion-style). */}
            <label className="flex min-h-8 min-w-0 flex-1 cursor-text items-start gap-1 rounded-md border bg-transparent px-1.5 py-0.5 has-[input:focus]:ring-1 has-[input:focus]:ring-ring">
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
              className="h-8 shrink-0 text-sm"
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
              {inviteUsers.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Invite'}
            </Button>
          </div>

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}
        </div>

        {/* People list. While typing it becomes two filtered sections,
            Notion-style: access holders ("Already shared with") and
            invitable candidates ("Not shared with"). */}
        <div className="max-h-72 overflow-y-auto px-1 pb-1">
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
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
