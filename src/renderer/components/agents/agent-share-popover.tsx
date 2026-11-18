import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { forwardRef, useEffect, useImperativeHandle, useState, useRef, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useUser } from '@renderer/context/user-context'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
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
import { formatFileSize } from '@shared/lib/utils/format-file-size'
import {
  useAgentTemplateStatus,
  useExportAgentTemplate,
  useExportAgentFull,
  useHostExportStatus,
} from '@renderer/hooks/use-agent-templates'
import { AgentTemplatePublishPanel } from '@renderer/components/agents/agent-template-publish-panel'
import { AgentTemplateStatus } from '@renderer/components/agents/agent-template-status'
import { ActivityOrb } from '@renderer/components/messages/activity-orb'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useAgent } from '@renderer/hooks/use-agents'
import {
  ArrowDownToLine,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  LibraryBig,
  Loader2,
  Lock,
  User,
  UserPlus,
  X,
} from 'lucide-react'
import type { AgentRole } from '@shared/lib/types/agent'
import { candidateKey, type InviteCandidate } from '@shared/lib/team-directory/candidate-schema'
import { agentAccessRole, type AgentAccessChange, type AgentAccessRole, type InboundXAgentBlockedAgent, type InboundXAgentCaller, memberAgentsOf, agentAccessNote } from '@shared/lib/types/inbound-x-agent-schema'
import { useInboundXAgentDetails, useSetAgentAccess } from '@renderer/hooks/use-inbound-x-agent'
import { NotOnGamutBadge } from './not-on-gamut-badge'
import { AgentFace } from './agent-face'

/**
 * Who the agent can be shared with: an account, a team-directory person with
 * none yet, or another agent. An agent's access is its own agent-to-agent
 * permission on this one, shown here in the roles people have.
 */
type Invitee = InviteCandidate | { kind: 'agent'; name: string; agent: InboundXAgentCaller }

function inviteeKey(invitee: Invitee): string {
  return invitee.kind === 'agent' ? `agent:${invitee.agent.slug}` : candidateKey(invitee)
}

interface AgentSharePopoverProps {
  agentSlug: string
  agentName: string
  trigger?: ReactNode
}

/** Imperative surface: lets the agent menu's "Export Agent" open this
 *  popover straight onto its Export pane. */
export interface AgentSharePopoverHandle {
  openExport: () => void
}

const ROLE_OPTIONS: { value: AgentRole; label: string; description: string }[] = [
  { value: 'owner', label: 'Owner', description: 'Full control of this agent' },
  { value: 'user', label: 'User', description: 'Can start sessions and chat' },
  { value: 'viewer', label: 'Viewer', description: 'Can view sessions only' },
]

const ROLE_LABELS: Record<AgentRole, string> = Object.fromEntries(
  ROLE_OPTIONS.map((r) => [r.value, r.label])
) as Record<AgentRole, string>

/** The same roles, as they apply to an agent. An agent is never an Owner. */
const AGENT_ROLE_OPTIONS: { value: AgentAccessRole; label: string; description: string }[] = [
  { value: 'user', label: ROLE_LABELS.user, description: 'Can message it and read its sessions and files' },
  { value: 'viewer', label: ROLE_LABELS.viewer, description: 'Can read its sessions and files' },
]

/** Sentinel value for the "Remove" item in the per-row role dropdown. */
const REMOVE_SENTINEL = '__remove__'
/**
 * A role short of what is saved holds no item's value, so picking the shown role still fires: a User with a
 * note on its reading gets reading, a Viewer that can't message here gets messaging pinned to asking first.
 */
const PARTIAL_ROLE = '__partial_role__'

/** What a picked item in an agent's role menu does. Remove block is a Remove: both end at asking first. */
export function agentAccessChange(value: string): AgentAccessChange | null {
  if (value === 'user' || value === 'viewer' || value === 'block') return value
  return value === REMOVE_SENTINEL ? 'remove' : null
}

/** Two-line role items (label + permission description) shared by both selects. */
export function RoleSelectItems({ options = ROLE_OPTIONS }: { options?: { value: AgentRole; label: string; description: string }[] }) {
  return (
    <>
      {options.map((role) => (
        <SelectItem key={role.value} value={role.value} className="pr-8 text-[11px]">
          <div className="flex flex-col items-start gap-0.5">
            <span>{role.label}</span>
            <span className="text-[10px] text-muted-foreground">{role.description}</span>
          </div>
        </SelectItem>
      ))}
    </>
  )
}

/**
 * Outside auth mode a local agent has no per-user ACL, so its people are just
 * whoever is at this computer. Agents can still be invited; people need Cloud.
 */
function LocalOwnerRow() {
  return (
    <div className="flex items-center gap-2 rounded-item px-2 py-1.5" data-testid="access-entry-you">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <User className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px]">You</div>
        <div className="truncate text-[11px] text-muted-foreground">This computer</div>
      </div>
      <span className="px-1.5 text-[11px] text-muted-foreground">{ROLE_LABELS.owner}</span>
    </div>
  )
}

function InviteTeammatesRow() {
  return (
    <div className="mx-1 mb-1 flex items-center gap-2 border-t px-2 pb-1.5 pt-3" data-testid="agent-invite-cloud-row">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground">
        <UserPlus className="h-3.5 w-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px]">Invite teammates</div>
        <div className="text-[11px] text-muted-foreground">
          Switch to Gamut Cloud to share this agent with people.
        </div>
      </div>
    </div>
  )
}

/**
 * Share button + popover for the agent header, with Notion-style panes:
 * Invite (who can use this agent: people and other agents in one list),
 * Publish (template export + skillset publishing, moved here from the
 * settings General tab) and Export. People are a per-user ACL, auth mode
 * only (the /access endpoints are AgentAdmin()-guarded); agents are the
 * agent-to-agent permissions, which exist in every mode. Rendered for agent
 * owners; in non-auth deployments everyone is an owner, so the Invite tab
 * lists agents and points at Cloud for people.
 */
export const AgentSharePopover = forwardRef<AgentSharePopoverHandle, AgentSharePopoverProps>(
  function AgentSharePopover({ agentSlug, agentName, trigger }, ref) {
  const queryClient = useQueryClient()
  const { user, isAuthMode, canUseAgent } = useUser()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'share' | 'publish' | 'export'>('share')
  const [searchQuery, setSearchQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [selectedInvitees, setSelectedInvitees] = useState<Invitee[]>([])
  const [inviteRole, setInviteRole] = useState<AgentRole>('user')
  const [publishFlowOpen, setPublishFlowOpen] = useState(false)
  const [exportChoice, setExportChoice] = useState<'template' | 'full'>('template')
  const [confirmFullExportOpen, setConfirmFullExportOpen] = useState(false)
  const [fullExportBytes, setFullExportBytes] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { data: agent } = useAgent(open ? agentSlug : null)

  useImperativeHandle(ref, () => ({
    openExport: () => {
      setTab('export')
      setOpen(true)
    },
  }), [])

  // Publish pane data/mutations. Status only fetches once the popover opens.
  const {
    data: templateStatus,
    isPending: templateStatusPending,
    isError: templateStatusError,
  } = useAgentTemplateStatus(open ? agentSlug : null)
  const exportTemplate = useExportAgentTemplate()
  const exportFull = useExportAgentFull()
  // Host-wide guard: exports stream large archives, so any in-flight export
  // (this window or another) disables the button, same as the settings tab did.
  // Only fetched (and polled) while the popover is open — the popover itself
  // is mounted with the header on every agent-home visit.
  const { data: hostExportStatus } = useHostExportStatus(open)
  const exportPending =
    !!hostExportStatus?.inProgress || exportTemplate.isPending || exportFull.isPending
  const canPublish = templateStatus?.type === 'local' && templateStatus.publishable !== false

  const resetInvite = () => {
    setSelectedInvitees([])
    setSearchQuery('')
    setInviteRole('user')
    setError(null)
    // Closing the popover also abandons an in-progress publish flow and
    // returns to the default tab and export choice, so reopening always
    // lands on Invite (with the invite input focused in auth mode).
    setPublishFlowOpen(false)
    setExportChoice('template')
    setTab('share')
  }

  const invalidateAccess = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-members', agentSlug] })
    queryClient.invalidateQueries({ queryKey: ['agent-invite-candidates', agentSlug] })
    queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
  }

  const { data: accessList, isLoading: membersLoading, isError: membersError, refetch: refetchMembers } = useAgentMembers(agentSlug, open)
  // The other agents that can reach this one, each with what it may do here.
  const { data: inboundDetails, isLoading: agentsLoading, isError: agentsError, refetch: refetchAgents } = useInboundXAgentDetails(agentSlug, open)
  // An older cloud server can't change an agent's role and doesn't send the blocked list: Share lists people only there.
  const peopleOnly = inboundDetails !== undefined && inboundDetails.blocked === undefined
  const inbound = peopleOnly ? undefined : inboundDetails
  const setAgentAccess = useSetAgentAccess(agentSlug)
  const [showBlocked, setShowBlocked] = useState(false)

  // The server caps results at 50 users, so client-side filtering alone can't
  // find everyone in a larger workspace — re-query with the typed text
  // (debounced) so the server searches the full user table.
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 200)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Invitable users (workspace members minus current access holders): the
  // first 50 as suggestions when idle, server-side search results while typing.
  const { data: candidates } = useQuery<InviteCandidate[]>({
    queryKey: ['agent-invite-candidates', agentSlug, debouncedQuery],
    queryFn: async () => {
      const qs = debouncedQuery ? `?q=${encodeURIComponent(debouncedQuery)}` : ''
      const res = await apiFetch(`/api/agents/${agentSlug}/access/search-users${qs}`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: open && isAuthMode,
    // Keep the previous list on screen while the next query's fetch lands,
    // so typing filters instantly instead of flashing empty.
    placeholderData: (prev) => prev,
  })

  // Invite the selected batch. Runs each grant individually so one failure
  // doesn't sink the rest; succeeded users leave the chip row, failures stay.
  const inviteUsers = useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ users, role }: { users: Invitee[]; role: AgentRole }) => {
      const succeeded = new Set<string>()
      const failures: string[] = []
      for (const u of users) {
        if (u.kind === 'agent') {
          try {
            await setAgentAccess.mutateAsync({ callerSlug: u.agent.slug, change: role === 'viewer' ? 'viewer' : 'user' })
            succeeded.add(inviteeKey(u))
          } catch (err) {
            failures.push(`${u.name}: ${err instanceof Error ? err.message : 'Failed to invite agent'}`)
          }
          continue
        }
        // A directory person has no account yet: the server makes an invited one.
        const target = u.kind === 'directory' ? { directoryRef: u.directoryRef } : { userId: u.id }
        const res = await apiFetch(`/api/agents/${agentSlug}/access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...target, role }),
        })
        if (res.ok) {
          succeeded.add(inviteeKey(u))
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
        setSelectedInvitees((prev) => prev.filter((u) => !succeeded.has(inviteeKey(u))))
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

  const selectedIds = new Set(selectedInvitees.map(inviteeKey))
  const accessIds = new Set(accessList?.map((e) => e.id) ?? [])
  const accessEmails = new Set(accessList?.map((e) => e.email.toLowerCase()) ?? [])
  const filter = searchQuery.trim().toLowerCase()
  // Candidates are already ACL-filtered server-side; re-filter here so the list
  // updates instantly after an invite (before the refetch lands). A directory
  // person just invited is a member by email until the refetch drops them.
  const suggested = (candidates ?? []).filter(
    (u) =>
      (u.kind === 'directory' ? !accessEmails.has(u.email.toLowerCase()) : !accessIds.has(u.id)) &&
      (!filter || u.name.toLowerCase().includes(filter) || u.email.toLowerCase().includes(filter))
  )

  // Access holders matching the typed query — the "Already shared with"
  // section while searching.
  const matchedAccess = filter
    ? (accessList ?? []).filter(
        (e) => e.name.toLowerCase().includes(filter) || e.email.toLowerCase().includes(filter)
      )
    : []

  // Agents with a role here are members; the rest can be invited by whoever
  // uses them too (a link needs someone who uses both agents).
  const canChangeAgent = (agent: Pick<InboundXAgentCaller, 'slug' | 'canAccess'>) => agent.canAccess && canUseAgent(agent.slug)
  const matchesAgent = (agent: InboundXAgentCaller) =>
    !filter || agent.name.toLowerCase().includes(filter) || agent.displaySlug.toLowerCase().includes(filter)
  // A block in either direction keeps an agent out of both lists; it shows under the blocked line instead.
  const blockedAgents = inbound?.blocked ?? []
  const blockedSlugs = new Set(blockedAgents.map((agent) => agent.slug))
  const unblockedCallers = (inbound?.callers ?? []).filter((agent) => !blockedSlugs.has(agent.slug))
  const agentMembers = memberAgentsOf({ callers: inbound?.callers ?? [], blocked: blockedAgents })
  const matchedAgentMembers = filter ? agentMembers.filter(matchesAgent) : []
  // An agent whose own setting blocks reading every agent can't be a member, so it isn't offered either.
  const suggestedAgents = unblockedCallers.filter((agent) =>
    agentAccessRole(agent) === null && agent.readDecision !== 'block' && canChangeAgent(agent) && matchesAgent(agent)
  )

  const changeAgentAccess = (agent: InboundXAgentCaller | InboundXAgentBlockedAgent, value: string) => {
    const change = agentAccessChange(value)
    if (!change) return
    setError(null)
    setAgentAccess.mutate({ callerSlug: agent.slug, change }, { onError: (err: Error) => setError(err.message) })
  }

  // An agent is never an Owner, so the batch role leaves it out once one is picked.
  const agentSelected = selectedInvitees.some((s) => s.kind === 'agent')
  const personSelected = selectedInvitees.some((s) => s.kind !== 'agent')
  const inviteRoleOptions = !isAuthMode || (agentSelected && !personSelected)
    ? AGENT_ROLE_OPTIONS
    : agentSelected
      ? ROLE_OPTIONS.filter((r) => r.value !== 'owner')
      : ROLE_OPTIONS

  const toggleInvitee = (u: Invitee) => {
    const key = inviteeKey(u)
    setSelectedInvitees((prev) =>
      prev.some((s) => inviteeKey(s) === key) ? prev.filter((s) => inviteeKey(s) !== key) : [...prev, u]
    )
    if (u.kind === 'agent' && inviteRole === 'owner') setInviteRole('user')
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  // An agent in the people list: same row, its orb for a face, no Owner role. A blocked agent uses the same row:
  // a role lifts the block and sets it, and Remove block is last.
  const renderAgent = (agent: InboundXAgentCaller | InboundXAgentBlockedAgent, role: AgentAccessRole | 'blocked' | null) => {
    if (!role) return null
    const testId = role === 'blocked' ? 'access-blocked' : 'access-agent'
    const label = role === 'blocked' ? 'Blocked' : ROLE_LABELS[role]
    // Permissions saved elsewhere can grant or block less than a role does. The line under the name says so.
    const note = agentAccessNote({ role, readDecision: agent.readDecision, blocks: 'blocks' in agent ? agent.blocks : undefined })
    return (
      <div
        key={`${testId}:${agent.slug}`}
        className="flex items-center gap-2 rounded-item px-2 py-1.5 hover:bg-accent/50"
        data-testid={`${testId}-${agent.slug}`}
      >
        <AgentFace agent={agent} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px]">{agent.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{note ?? 'Agent'}</div>
        </div>
        {canChangeAgent(agent) ? (
          <Select value={role === 'blocked' ? '' : (role === 'user' && note) || (role === 'viewer' && agent.canMessage === false) ? PARTIAL_ROLE : role} onValueChange={(next) => changeAgentAccess(agent, next)} disabled={setAgentAccess.isPending}>
            <SelectTrigger
              className="h-7 w-auto shrink-0 gap-1 border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
              data-testid={`${testId}-role-${agent.slug}`}
            >
              {/* A blocked row has no value picked, and SelectValue would show the empty placeholder. */}
              {role === 'blocked' ? <span>{label}</span> : <SelectValue>{label}</SelectValue>}
            </SelectTrigger>
            <SelectContent align="end" className="w-64">
              <RoleSelectItems options={AGENT_ROLE_OPTIONS} />
              <SelectSeparator />
              {role === 'blocked' ? (
                <SelectItem value={REMOVE_SENTINEL} className="pr-8 text-[11px]" data-testid={`access-unblock-${agent.slug}`}>
                  Remove block
                </SelectItem>
              ) : (
                // Block is rare, so it sits faint at the end of Remove's line and turns orange when pointed at.
                <div className="flex items-center">
                  <SelectItem
                    value={REMOVE_SENTINEL}
                    className="flex-1 pr-2 text-[11px] text-destructive focus:text-destructive"
                    data-testid={`access-agent-remove-${agent.slug}`}
                  >
                    Remove
                  </SelectItem>
                  <SelectItem
                    value="block"
                    className="mr-1 w-auto shrink-0 py-0.5 pl-1.5 pr-1.5 text-[11px] text-muted-foreground/50 focus:bg-orange-100 focus:text-orange-700 dark:focus:bg-orange-950/60 dark:focus:text-orange-400"
                    data-testid={`access-agent-block-${agent.slug}`}
                  >
                    <span className="flex items-center gap-1"><Ban className="h-3 w-3" aria-hidden />Block</span>
                  </SelectItem>
                </div>
              )}
            </SelectContent>
          </Select>
        ) : (
          // Changing it takes someone who uses that agent too.
          <span className="px-1.5 text-[11px] text-muted-foreground" data-testid={`${testId}-role-locked-${agent.slug}`}>{label}</span>
        )}
      </div>
    )
  }

  const agentsErrorRow = (
    <div className="px-2 py-2 text-xs text-muted-foreground">
      Could not load agents. <button className="underline" onClick={() => void refetchAgents()}>Try again</button>
    </div>
  )

  // Shared by the default people list and the "Already shared with" section.
  const renderPersonMember = (entry: AgentMember) => {
    const isLastOwner = entry.role === 'owner' && ownerCount <= 1
    const isSelf = entry.id === user?.id
    return (
      <div
        key={entry.id}
        className="flex items-center gap-2 rounded-item px-2 py-1.5 hover:bg-accent/50"
        data-testid={`access-entry-${entry.id}`}
      >
        <span className={cn(entry.invited && 'opacity-50')}><UserAvatar user={entry} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span className={cn('truncate', entry.invited && 'opacity-50')}>{entry.name}</span>
            {isSelf && <span className="text-muted-foreground"> (You)</span>}
            {entry.invited && <NotOnGamutBadge label="Invite pending" />}
          </div>
          <div className={cn('truncate text-[11px] text-muted-foreground', entry.invited && 'opacity-50')}>{entry.email}</div>
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
                      removeAccess.mutate(entry.id)
                    } else {
                      changeRole.mutate({ userId: entry.id, role: role as AgentRole })
                    }
                  }}
                >
                  <SelectTrigger
                    className="h-7 w-auto shrink-0 gap-1 border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid={`access-role-${entry.id}`}
                  >
                    <SelectValue>{ROLE_LABELS[entry.role]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end" className="w-64">
                    <RoleSelectItems />
                    <SelectSeparator />
                    {/* Only Remove is guarded for the last owner — the role
                        options stay viewable; demotion is server-guarded. */}
                    <SelectItem
                      value={REMOVE_SENTINEL}
                      disabled={isLastOwner}
                      className="pr-8 text-[11px] text-destructive focus:text-destructive"
                      data-testid={`access-remove-${entry.id}`}
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
    <>
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetInvite()
      }}
    >
      <PopoverTrigger asChild>
        {trigger ?? <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          aria-label="Share agent"
          data-testid="agent-share-button"
        >
          Share
        </Button>}
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
          if (tab === 'share') {
            setTimeout(() => searchInputRef.current?.focus(), 0)
          }
        }}
        data-testid="agent-share-popover"
      >
        {/* Tab bar — the publish flow replaces it with its own back
            navigation. Same segmented Tabs control as the connection
            directory's APIs/MCPs. */}
        {!(tab === 'publish' && publishFlowOpen) && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <div className="px-3 pt-3">
              <TabsList className="h-8">
                {([
                  { id: 'share', label: 'Invite' } as const,
                  { id: 'publish', label: 'Publish' } as const,
                  { id: 'export', label: 'Export' } as const,
                ]).map((t) => (
                  <TabsTrigger
                    key={t.id}
                    value={t.id}
                    className="px-2.5 text-[11px]"
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
            <div className="p-3" data-testid="agent-publish-pane">
              {templateStatusPending ? (
                // Don't show the "isn't available" message while the status is
                // still loading — that's the common case on first open.
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : templateStatusError ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  Couldn&apos;t check whether this agent can be published. Close and
                  reopen to retry.
                </p>
              ) : canPublish ? (
                <div className="space-y-4">
                  {/* Hero (Notion "Publish to web"-style) */}
                  <div className="space-y-1 pt-2 text-center">
                    <p className="text-sm font-medium">Publish to a Skillset</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="block">
                        Skillsets are shared collections of agent templates and skills.
                      </span>
                      <span className="block">
                        Publish this agent so teammates can install their own copy.
                      </span>
                    </p>
                  </div>

                  {/* Diagram: the agent card rises to the cloud skillset, which
                      fans out to clustered teammates ready to run their copy. */}
                  {/* Fixed 416x224 coordinate system: user centers sit on a
                      75px radius around the cloud center (208,116) at 0° and
                      ±50°/±95° from vertical, so all five are equidistant. */}
                  <div className="relative h-60 overflow-hidden rounded-item bg-gradient-to-b from-muted/70 to-transparent" aria-hidden="true">
                    {/* Dashed arrows: pill → cloud, cloud → each teammate.
                        Painted first so the circles sit on top. */}
                    <svg className="absolute inset-0 h-full w-full text-foreground" viewBox="0 0 416 240" preserveAspectRatio="none">
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
                        // [x1, y1, x2, y2, arrowhead] — only the card→skillset
                        // line keeps its head; the radial spokes are plain.
                        [208, 168, 208, 147, true], // agent card up to the skillset
                        [208, 86, 208, 65, false], // skillset → top teammate
                        [185, 97, 169, 83, false], // skillset → upper-left
                        [231, 97, 247, 83, false], // skillset → upper-right
                        [178, 119, 157, 120, false], // skillset → lower-left
                        [238, 119, 259, 120, false], // skillset → lower-right
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

                    {/* Teammates, all 75px from the skillset center (5th on top) */}
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

                    {/* The skillset in the cloud */}
                    <div className="absolute left-1/2 top-[92px] flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-control border bg-background shadow-md">
                      <LibraryBig className="h-5 w-5 text-foreground/70" />
                    </div>

                    {/* The agent, Manus-pill style */}
                    <div className="absolute bottom-4 left-1/2 flex w-max max-w-[75%] -translate-x-1/2 items-center gap-2 rounded-card border bg-background py-2 pl-3 pr-4 shadow-sm">
                      {/* The agent's avatar, or the thought orb when it has none */}
                      <div className="shrink-0">
                        {agent?.avatar
                          ? <AgentAvatar agent={agent} state="idle" size={28} />
                          : <ActivityOrb state="spinning" size={28} />}
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

                  {/* What publishing to a skillset actually means */}
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <p className="flex items-start gap-2">
                      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Agent only published as template. Secrets &amp; session
                      data are excluded.
                    </p>
                  </div>
                </div>
              ) : templateStatus && (templateStatus.type !== 'local' || !!templateStatus.sourceLabel) ? (
                // Installed from a library: instead of a publish flow, show
                // where it came from and the update / sync / review actions.
                <AgentTemplateStatus agentSlug={agentSlug} templateStatus={templateStatus} />
              ) : (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  Publishing isn&apos;t available — this agent can&apos;t be republished
                  from this workspace.
                </p>
              )}
            </div>
          )
        )}

        {tab === 'export' && (
          /* ── Export pane: template + full-agent downloads ── */
          <div className="space-y-3 p-3" data-testid="agent-export-pane">
            <div role="radiogroup" aria-label="Export type" className="-mx-2 space-y-1">
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
                    className="flex w-full items-center gap-3 rounded-item px-2 py-2 text-left hover:bg-accent"
                    onClick={() => setExportChoice(option.id)}
                    data-testid={`export-option-${option.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px]">{option.title}</p>
                      <p className="text-[11px] text-muted-foreground">{option.description}</p>
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
                  // Full exports contain secrets — confirm before downloading.
                  // The dialog is modal (outside the popover), so opening it
                  // dismisses the popover, same as the agent menu's delete
                  // confirm.
                  setOpen(false)
                  setConfirmFullExportOpen(true)
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
          /* ── Invite pane: people (auth mode) and agents in one list ── */
          <>
        {/* Invite row: chip box + batch role + Add */}
        <div className="space-y-2 px-3 pb-4 pt-5">
          <div className="flex items-start gap-2">
            {/* label: clicking anywhere in the chip box natively focuses the input.
                The role select sits inside the box, pinned top-right (Notion-style). */}
            <label className="flex min-h-8 min-w-0 flex-1 cursor-text items-start gap-1 rounded-item border bg-transparent px-1.5 py-0.5 has-[input:focus]:ring-1 has-[input:focus]:ring-ring">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {selectedInvitees.map((u) => (
                  <span
                    key={inviteeKey(u)}
                    className={cn(
                      'flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]',
                      u.kind !== 'agent' && u.notOnGamut && 'border border-dashed border-muted-foreground/50 bg-transparent',
                    )}
                    data-testid={`invite-chip-${inviteeKey(u)}`}
                  >
                    {u.kind === 'agent'
                      ? <AgentFace agent={u.agent} size={16} />
                      : <UserAvatar user={{ ...u, id: candidateKey(u) }} size={16} />}
                    <span className="max-w-32 truncate">{u.name}</span>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedInvitees((prev) => prev.filter((s) => inviteeKey(s) !== inviteeKey(u)))
                      }}
                      aria-label={`Remove ${u.name} from invite`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  ref={searchInputRef}
                  placeholder={selectedInvitees.length ? '' : isAuthMode ? (peopleOnly ? 'Invite people...' : 'Invite people or agents...') : 'Invite agents...'}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && !searchQuery && selectedInvitees.length) {
                      setSelectedInvitees((prev) => prev.slice(0, -1))
                    }
                  }}
                  className="h-6 min-w-20 flex-1 bg-transparent px-1 text-[11px] outline-none placeholder:text-muted-foreground"
                  data-testid="invite-search-input"
                />
              </div>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as AgentRole)}>
                <SelectTrigger
                  className="h-6 w-auto shrink-0 gap-1 border-none bg-transparent px-1 text-[11px] text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
                  data-testid="invite-role-select"
                >
                  <SelectValue>{ROLE_LABELS[inviteRole]}</SelectValue>
                </SelectTrigger>
                <SelectContent align="end" className="w-64">
                  <RoleSelectItems options={inviteRoleOptions} />
                </SelectContent>
              </Select>
            </label>
            <Button
              size="sm"
              className="h-8 shrink-0 text-[11px]"
              onClick={() => {
                if (inviteUsers.isPending) return
                // No disabled state: with nothing selected, just refocus the input
                if (!selectedInvitees.length) {
                  searchInputRef.current?.focus()
                  return
                }
                inviteUsers.mutate({ users: selectedInvitees, role: inviteRole })
              }}
              data-testid="invite-add-button"
            >
              {inviteUsers.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Invite'}
            </Button>
          </div>

          {error && <p className="px-1 text-[11px] text-destructive">{error}</p>}
        </div>

        {/* Who has access. While typing it becomes two filtered sections,
            Notion-style: access holders ("Already shared with") and
            invitable candidates ("Not shared with"). People come first,
            then agents, as in the @ menu. */}
        <div className="max-h-72 overflow-y-auto px-1 pb-2">
          {(isAuthMode && membersLoading) || agentsLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : isAuthMode && membersError ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              Could not load members. <button className="underline" onClick={() => void refetchMembers()}>Try again</button>
            </div>
          ) : filter ? (
            <>
              {matchedAccess.length + matchedAgentMembers.length > 0 && (
                <>
                  <p className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">
                    Already shared with
                  </p>
                  {matchedAccess.map(renderPersonMember)}
                  {matchedAgentMembers.map((agent) => renderAgent(agent, agent.role))}
                </>
              )}
              {suggested.length + suggestedAgents.length > 0 && (
                <>
                  <p className={cn('px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground', matchedAccess.length + matchedAgentMembers.length > 0 && 'pt-2')}>
                    Not shared with
                  </p>
                  {[...suggested, ...suggestedAgents.map((agent): Invitee => ({ kind: 'agent', name: agent.name, agent }))].map((u) => {
                    const key = inviteeKey(u)
                    const isSelected = selectedIds.has(key)
                    // People not on Gamut yet are drawn at half strength; picking one invites them.
                    const faded = u.kind !== 'agent' && u.notOnGamut
                    return (
                      <button
                        key={key}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-item px-2 py-1.5 text-left text-[11px] hover:bg-accent"
                        onClick={() => toggleInvitee(u)}
                        role="checkbox"
                        aria-checked={isSelected}
                        data-testid={u.kind === 'agent' ? `invite-agent-result-${u.agent.slug}` : `invite-user-result-${key}`}
                      >
                        {u.kind === 'agent'
                          ? <AgentFace agent={u.agent} />
                          : <span className={cn(faded && 'opacity-50')}><UserAvatar user={{ ...u, id: key }} /></span>}
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className={cn('truncate', faded && 'opacity-50')}>{u.name}</span>
                            {faded && <NotOnGamutBadge />}
                          </div>
                          <div className={cn('truncate text-[11px] text-muted-foreground', faded && 'opacity-50')}>
                            {u.kind === 'agent' ? 'Agent' : `${u.email}${u.kind === 'directory' ? ` · ${u.source}` : ''}`}
                          </div>
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
              {agentsError && agentsErrorRow}
              {!agentsError && matchedAccess.length + matchedAgentMembers.length + suggested.length + suggestedAgents.length === 0 && (
                <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                  {isAuthMode ? (peopleOnly ? 'No people found' : 'No people or agents found') : 'No agents found'}
                </div>
              )}
            </>
          ) : isAuthMode && !accessList?.length && !agentMembers.length ? (
            <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
              No one has access to this agent.
            </div>
          ) : (
            <>
              <p className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">
                Members with access
              </p>
              {isAuthMode ? accessList?.map(renderPersonMember) : <LocalOwnerRow />}
              {agentMembers.length > 0 && (
                <p className="px-2 pb-1 pt-2.5 text-[11px] text-muted-foreground">Agents with access</p>
              )}
              {agentsError && agentsErrorRow}
              {agentMembers.map((agent) => renderAgent(agent, agent.role))}
              {blockedAgents.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowBlocked((shown) => !shown)}
                    aria-expanded={showBlocked}
                    className="flex items-center gap-1 px-2 pb-1 pt-2.5 text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
                    data-testid="access-blocked-toggle"
                  >
                    {blockedAgents.length} blocked {blockedAgents.length === 1 ? 'agent' : 'agents'}
                    <ChevronDown className={cn('h-3 w-3 transition-transform', showBlocked && 'rotate-180')} aria-hidden />
                  </button>
                  {showBlocked && blockedAgents.map((agent) => renderAgent(agent, 'blocked'))}
                </>
              )}
            </>
          )}
        </div>
        {!isAuthMode && <InviteTeammatesRow />}
          </>
        )}
      </PopoverContent>
    </Popover>

    {/* Full-agent exports bundle env vars, API keys, and session data —
        keep an explicit confirmation in front of the download. */}
    <AlertDialog
      open={confirmFullExportOpen}
      onOpenChange={(next) => {
        // Stay open until the download lands so the user can see it running.
        if (!next && exportFull.isPending) return
        setConfirmFullExportOpen(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Export Full Agent</AlertDialogTitle>
          <AlertDialogDescription>
            This will export the entire agent workspace including environment
            variables, API keys, and other potentially sensitive data. Only share
            this file with people you trust.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {exportFull.isPending && (
          <div className="space-y-1.5" data-testid="full-export-progress">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-2/5 rounded-full bg-primary animate-progress-indeterminate motion-reduce:animate-none" />
            </div>
            <p className="text-xs text-muted-foreground">
              {fullExportBytes > 0
                ? `${formatFileSize(fullExportBytes)} downloaded`
                : 'Preparing export…'}
            </p>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={exportFull.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={exportPending}
            onClick={(event) => {
              event.preventDefault()
              setFullExportBytes(0)
              exportFull.mutate(
                { agentSlug, agentName, onProgress: setFullExportBytes },
                { onSettled: () => setConfirmFullExportOpen(false) },
              )
            }}
            data-testid="confirm-full-export-button"
          >
            {exportFull.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Exporting…
              </>
            ) : (
              'Export'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
})
