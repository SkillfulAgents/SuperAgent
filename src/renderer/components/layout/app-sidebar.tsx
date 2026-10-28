
import { AtSign, Bell, Brain, ChevronDown, ChevronLeft, ChevronRight, Cloud, Laptop, Plus, Search, Settings, AlertTriangle, LayoutGrid, ListTodo, SquareMousePointer, LogOut, Compass, MoonStar, SquarePen } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { AppLink } from '@renderer/components/ui/app-link'
import { ContextMenuMoreButton } from '@renderer/components/ui/context-menu'
import { UnreadDot } from '@renderer/components/agents/status-indicators'
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { isElectron, getPlatform, openDashboardExternal } from '@renderer/lib/env'
import { openExternalUrl } from '@renderer/lib/open-external'
import { targetIsRemote } from '@renderer/lib/api-target'
import { resolveSidebarVersionState } from '@renderer/components/layout/sidebar-version-state'
import { TargetSwitcher } from '@renderer/components/layout/target-switcher'
import { useTargetSwitch } from '@renderer/hooks/use-target-switch'
import { hasInteractiveLogin } from '@renderer/lib/auth-mode'
import { useDialogs } from '@renderer/context/dialog-context'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import {
  Collapsible,
  CollapsibleContent,
} from '@renderer/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@renderer/components/ui/sidebar'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import {
  FirewallBlockedSidebarBanner,
  OfflineSidebarBanner,
  RuntimeUnavailableSidebarBanner,
  RuntimeCheckingSidebarBanner,
  RuntimePullingSidebarBanner,
  ServicesDegradedSidebarBanner,
  SidebarBannerStack,
  type FirewallFixUiState,
} from '@renderer/components/runtime/runtime-status-banners'
import { useFirewallStatus, useFixFirewall } from '@renderer/hooks/use-firewall-status'
import { useAgents, useListedAgents, useRouteAgentId, useStartAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSessions, type ApiSession } from '@renderer/hooks/use-sessions'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSettings, useModelSettings, useWarmStartOnTypeEnabled } from '@renderer/hooks/use-settings'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useExperiment } from '@renderer/hooks/use-experiment'
import { useTodos } from '@renderer/hooks/use-todos'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { SidebarMemberIndicator } from '@renderer/components/agents/sidebar-member-indicator'
import { WorkingDots, AwaitingDot } from '@renderer/components/agents/status-indicators'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { agentActivity, agentAvatarState } from '@shared/lib/types/agent-activity-status'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { formatLastRun } from '@renderer/lib/last-run'
import { SIDEBAR_TREE_CONNECTORS } from '@renderer/components/ui/tree-connectors'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { DashboardContextMenu } from '@renderer/components/dashboards/dashboard-context-menu'
import { useQueryClient } from '@tanstack/react-query'
import { useParams, useRouterState } from '@tanstack/react-router'
import { apiFetch } from '@renderer/lib/api'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useHistoryNavigation } from '@renderer/router/use-history-navigation'
import { useSearch } from '@renderer/context/search-context'
import { useCmdHintTarget, CmdHintBadge } from '@renderer/context/cmd-hint-context'
import { useArtifacts, type ArtifactInfo } from '@renderer/hooks/use-artifacts'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { useUser } from '@renderer/context/user-context'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
import { usePlatformUnreadCount } from '@renderer/hooks/use-platform-notifications'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { HoverScrollText } from '@renderer/components/ui/hover-scroll-text'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type UniqueIdentifier,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  type SortingStrategy,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableAgentMenuItem } from './sortable-agent-item'
import { AGENT_AVATAR_LEFT, AGENT_AVATAR_SIZE, SIDEBAR_FOLLOW_REGION } from './sidebar-avatar'
import { SidebarDragProvider, useSidebarDragActive } from './sidebar-drag-context'
import {
  AgentDragOverlayRow,
  AgentFolderBlock,
  SECTION_ICON_CLASS,
  SECTION_ROW_CLASS,
  agentDropAnimation,
} from './agent-folder-block'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import {
  containerIdForFolder,
  buildFolderSections,
  dissolveFolder,
  ROOT_FOLDER_ID,
  locateAgent,
  moveAgent,
  moveFolder,
  newFolderId,
  resolveAgentDrop,
  resolveFolderDrop,
  sanitizeFolders,
  sectionsToSettings,
  sortableIdForFolder,
  uniqueFolderName,
  applyTreeOperation,
  type TreeOperation,
} from '@renderer/lib/agent-folders'
import { useRenderTracker } from '@renderer/lib/perf'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useRememberedFlag } from '@renderer/hooks/use-remembered-flag'
import { useSidebarFileDrop } from './use-sidebar-file-drop'

/** Set once Team Brain has been opened, which retires its "New" badge: the badge invites a first look, then goes away. */
const TEAM_BRAIN_SEEN_KEY = 'team-brain.seen'

function VersionBehindDot({
  wayBehind,
  label,
}: {
  wayBehind: boolean
  label: string
}) {
  return (
    <span
      className={cn(
        'ml-0.5 h-1.5 w-1.5 rounded-full',
        wayBehind ? 'bg-orange-500' : 'bg-blue-500',
      )}
      aria-label={label}
    />
  )
}

// 4px-wide thin scrollbar with a muted-foreground/20 thumb. Reused on the
// agents-list group; pull out as a constant so the call site stays readable.
const THIN_SCROLLBAR =
  '[scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)/0.2)_transparent] ' +
  '[&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent ' +
  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20'

// Sensor options MUST be referentially stable. `useSensor` memoizes on the
// options object, so an inline literal here mints new sensor descriptors on
// every AppSidebar render — which makes DndContext rebuild its activators,
// which hands every `useSortable` row a brand-new `listeners` object, which
// breaks AgentMenuItem's memo for the entire list on every unrelated sidebar
// render. Measured: 80 filed agents cost 2 full row re-renders per row per
// toggle with inline options, ~0 with these hoisted.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } }
const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates }
const SIDEBAR_FILE_DROP_CUE =
  'data-[file-drop-active]:bg-sidebar-accent data-[file-drop-active]:ring-1 data-[file-drop-active]:ring-sidebar-ring'

/** The user-settings fields that together describe the left-nav tree. */
type AgentTreeSettings = ReturnType<typeof sectionsToSettings>

type ActiveDrag = { type: 'agent' | 'folder'; label: string; folderId?: string }

/** Where a dragged folder is currently set to land. */
type FolderDropCue = { folderId: string; edge: 'above' | 'below' }

// Session sub-item that tracks its streaming state
function SessionSubItem({
  session,
  agentSlug,
}: {
  session: ApiSession
  agentSlug: string
}) {
  useRenderTracker('SessionSubItem')
  // Active state is route-derived (URL is authoritative, read from useParams) so
  // the highlight + the stream subscription are correct on a cold reload, with no
  // in-memory selection state to wait on.
  const { sessionId: routeSessionId } = useParams({ strict: false }) as { sessionId?: string }
  const routeAgentId = useRouteAgentId()
  const isSelected = routeAgentId === agentSlug && routeSessionId === session.id
  const { isStreaming } = useMessageStream(isSelected ? session.id : null, isSelected ? agentSlug : null, ['isStreaming'])
  const isWorking = (session.isActive || isStreaming) && !session.isAwaitingInput
  const isAwaitingInput = session.isAwaitingInput
  const hasUnread = !session.isActive && !session.isAwaitingInput && session.hasUnreadNotifications
  // Pending-wake (long sleep) indicator: shown alongside the unread dot, but
  // suppressed while the session is actively working/awaiting (momentarily
  // redundant — the session clearly isn't asleep).
  const showPendingWake = !!session.pendingWakeAt && !isWorking && !isAwaitingInput
  const { ref: hintRef, hint } = useCmdHintTarget()
  const dragHandlers = useSidebarFileDrop({
    kind: 'session',
    agentSlug,
    sessionId: session.id,
    // No composer is mounted behind a pending request, so a drop would be
    // swallowed and then resurface once the request is answered.
    disabled: isAwaitingInput,
  })

  return (
    <SidebarMenuSubItem
      {...dragHandlers}
      className={cn('rounded-md', SIDEBAR_FILE_DROP_CUE)}
    >
      <SessionContextMenu
        sessionId={session.id}
        sessionName={session.name}
        agentSlug={agentSlug}
        activity={{
          isActive: !!session.isActive,
          isAwaitingInput: !!session.isAwaitingInput,
          isStreaming,
        }}
      >
        {/* The row (menu target) wraps the link and the 3-dot button, which
            can't nest inside the <a>; the link fills the rest of the row. */}
        <SidebarMenuSubButton
          asChild
          isActive={isSelected}
          className="relative gap-0 overflow-visible px-0"
        >
          <div>
            <AppLink
              ref={hintRef}
              to="/agents/$slug/sessions/$sessionId"
              params={{ slug: agentSlug, sessionId: session.id }}
              // Not draggable, as when the link was the menu trigger itself:
              // iOS would otherwise lift it on a long-press.
              draggable={false}
              className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-2 outline-none ring-sidebar-ring [-webkit-user-drag:none] focus-visible:ring-2"
              data-testid={`session-item-${session.id}`}
            >
              <HoverScrollText
                className="flex-1 text-left"
                data-testid={`session-name-${session.id}`}
                hoverTarget="parent"
              >
                {session.name}
              </HoverScrollText>
              {hint !== null ? (
                <CmdHintBadge hint={hint} />
              ) : (
                <span className="flex items-center justify-center gap-1 min-w-4 shrink-0">
                  {showPendingWake && (
                    <span
                      className="flex items-center"
                      role="img"
                      aria-label="scheduled to resume"
                      title={`Resumes ${formatDistanceToNow(new Date(session.pendingWakeAt!), { addSuffix: true })}`}
                      data-testid={`session-pending-wake-${session.id}`}
                    >
                      <MoonStar className="h-3 w-3 text-muted-foreground" />
                    </span>
                  )}
                  {isAwaitingInput ? (
                    <AwaitingDot />
                  ) : isWorking ? (
                    <WorkingDots />
                  ) : hasUnread ? (
                    <UnreadDot mention={session.hasUnreadMention} />
                  ) : null}
                </span>
              )}
            </AppLink>
            {hint === null && (
              <ContextMenuMoreButton
                label={`Options for ${session.name}`}
                // Spill to the right: a dropdown here would cover the rows below.
                anchor="beside"
                data-testid={`session-menu-button-${session.id}`}
                iconClassName="h-3.5 w-3.5"
                // After the status slot rather than over it, so the status (and
                // the resume-time title on its moon) stays readable on hover; no
                // width until revealed, so the row is unchanged at rest.
                className="h-5 w-0 overflow-hidden text-muted-foreground hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring menu-revealed:mr-1 menu-revealed:w-5"
              />
            )}
          </div>
        </SidebarMenuSubButton>
      </SessionContextMenu>
    </SidebarMenuSubItem>
  )
}

// Dashboard sub-item
function DashboardSubItem({
  artifact,
  agentSlug,
}: {
  artifact: ArtifactInfo
  agentSlug: string
}) {
  const { dashSlug: routeDashSlug } = useParams({ strict: false }) as { dashSlug?: string }
  const routeAgentId = useRouteAgentId()
  const isSelected = routeAgentId === agentSlug && routeDashSlug === artifact.slug
  const [isRenaming, setIsRenaming] = useState(false)
  const { ref: hintRef, hint } = useCmdHintTarget()

  const handleDoubleClick = () => {
    openDashboardExternal(agentSlug, artifact.slug, artifact.name)
  }

  return (
    <SidebarMenuSubItem>
      <DashboardContextMenu
        artifactSlug={artifact.slug}
        artifactName={artifact.name}
        agentSlug={agentSlug}
        onRenameRequest={() => setIsRenaming(true)}
      >
        <SidebarMenuSubButton
          asChild
          isActive={isSelected}
          title={`${artifact.description || artifact.name} (double-click to open in new window)`}
        >
          <AppLink
            ref={hintRef}
            to="/agents/$slug/dashboards/$dashSlug"
            params={{ slug: agentSlug, dashSlug: artifact.slug }}
            onDoubleClick={handleDoubleClick}
            className="flex items-center gap-2 w-full"
          >
            <SquareMousePointer className="!h-3.5 !w-3.5 shrink-0" />
            {isRenaming ? (
              <InlineRenameInput
                agentSlug={agentSlug}
                artifactSlug={artifact.slug}
                currentName={artifact.name}
                onDone={() => setIsRenaming(false)}
              />
            ) : (
              <span className="truncate">{artifact.name}</span>
            )}
            {hint !== null && <CmdHintBadge hint={hint} className="ml-auto" />}
          </AppLink>
        </SidebarMenuSubButton>
      </DashboardContextMenu>
    </SidebarMenuSubItem>
  )
}

function InlineRenameInput({
  agentSlug,
  artifactSlug,
  currentName,
  onDone,
}: {
  agentSlug: string
  artifactSlug: string
  currentName: string
  onDone: () => void
}) {
  const [value, setValue] = useState(currentName)
  const queryClient = useQueryClient()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const cancelledRef = React.useRef(false)
  const submittedRef = React.useRef(false)

  React.useEffect(() => {
    inputRef.current?.select()
  }, [])

  const submit = async () => {
    if (submittedRef.current || cancelledRef.current) return
    submittedRef.current = true
    const trimmed = value.trim()
    if (trimmed && trimmed !== currentName) {
      try {
        const res = await apiFetch(`/api/agents/${agentSlug}/artifacts/${artifactSlug}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        })
        if (res.ok) {
          queryClient.invalidateQueries({ queryKey: ['artifacts', agentSlug] })
        }
      } catch (error) {
        console.error('Failed to rename dashboard:', error)
      }
    }
    onDone()
  }

  const cancel = () => {
    cancelledRef.current = true
    onDone()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') cancel()
      }}
      onBlur={submit}
      onClick={(e) => e.stopPropagation()}
      autoFocus
      className="w-full bg-background border border-input rounded px-1 py-0 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

// Skeleton shown briefly while session data loads on expand
function SessionsSkeleton() {
  return (
    <>
      {[1, 2, 3].map((i) => (
        <SidebarMenuSubItem key={i}>
          <div className="flex items-center gap-2 px-2 py-1">
            <Skeleton className="h-3 w-3 rounded-full shrink-0" />
            <Skeleton className="h-3.5 flex-1" />
          </div>
        </SidebarMenuSubItem>
      ))}
    </>
  )
}

// Only this label subscribes to the clock; the expensive agent row stays memoized.
// The row's second line: when the agent last ran. A sleeping agent keeps it;
// its avatar shows the sleep (agentAvatarState).
function AgentLastRun({ date }: { date: ApiAgent['lastActivityAt'] }) {
  useMinuteClock()
  return (
    <span className="block truncate text-[11px] leading-tight text-muted-foreground/60">
      {formatLastRun(date) ?? 'Never active'}
    </span>
  )
}

// The agent row's notification dot, pinned to the avatar's bottom-right like a
// presence dot: orange while a session waits on the user, otherwise blue for
// unread, or a small violet @ on white (near-black in dark) when it mentions
// you. Awaiting aggregates across sessions with the same formula as the agent
// header's AgentStatus (fresh sessions data when loaded, agent-level flags as
// fallback), so the sidebar and the top nav never disagree. Unread is
// suppressed when expanded: the session rows already point at the unread
// session.
function agentBadgeKind(agent: ApiAgent, sessions: ApiSession[] | undefined, isOpen: boolean) {
  if (agentActivity(agent, sessions).isAwaiting) return 'awaiting'
  if (isOpen || !agent.hasUnreadNotifications) return null
  return agent.hasUnreadMention ? 'mention' : 'unread'
}

// Each badge sits in a 2px gap cut out of the avatar rather than a ring painted
// in the sidebar colour, so whatever is behind the row (the glass, a hover or
// selected fill) shows through and nothing has to match it. Every badge shares
// one centre within the 32px avatar, 5px in from its bottom-right corner: the 6px
// dots sit inside it, the 14px @ overhangs it by 2px. A mask also hides
// everything outside its own box, and needs input's hop and squash carry the
// orb past the avatar's edges, so the mask sits on a frame 12px bigger all
// round (AvatarCutout); the centre is measured from that frame's corner.
const AVATAR_BADGE_CUTOUT = {
  awaiting: '[mask-image:radial-gradient(circle_at_39px_39px,transparent_4.5px,#000_5px)]',
  unread: '[mask-image:radial-gradient(circle_at_39px_39px,transparent_4.5px,#000_5px)]',
  mention: '[mask-image:radial-gradient(circle_at_39px_39px,transparent_6.5px,#000_7px)]',
} as const

function AvatarCutout({ cutout, children }: { cutout: string | null; children: React.ReactNode }) {
  if (!cutout) return <>{children}</>
  return <span className={cn('-m-3 block p-3', cutout)}>{children}</span>
}

function AgentAvatarBadge({
  agent,
  sessions,
  isOpen,
  className,
}: {
  agent: ApiAgent
  sessions: ApiSession[] | undefined
  isOpen: boolean
  className?: string
}) {
  const kind = agentBadgeKind(agent, sessions, isOpen)
  if (!kind) return null
  const isAwaiting = kind === 'awaiting'
  const isMention = kind === 'mention'
  const label = isAwaiting ? 'needs input' : isMention ? 'mentioned you' : 'unread notifications'
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid={`agent-avatar-badge-${agent.slug}`}
      className={cn(
        'pointer-events-none absolute rounded-full',
        isMention
          // A bare @ with no disc behind it: the cut-out alone separates it.
          ? '-right-0.5 -bottom-0.5 flex h-3.5 w-3.5 items-center justify-center text-violet-600 dark:text-purple-400'
          // The dots need no ring: AVATAR_BADGE_CUTOUT separates them.
          : cn('right-0.5 bottom-0.5 h-1.5 w-1.5', isAwaiting ? 'bg-orange-500' : 'bg-blue-500'),
        className,
      )}
    >
      {isMention && <AtSign className="h-[11px] w-[11px]" strokeWidth={3} aria-hidden />}
    </span>
  )
}

// Agent menu item with expandable sessions
const AgentMenuItemInner = React.forwardRef<
  HTMLLIElement,
  { agent: ApiAgent } & React.HTMLAttributes<HTMLLIElement>
>(({ agent, style, ...rest }, ref) => {
  useRenderTracker('AgentMenuItem')
  const { view } = useRouteLocation()
  const { isAuthMode, agentMemberCount, canUseAgent } = useUser()
  const queryClient = useQueryClient()
  // Route-derived selection (URL is authoritative — correct on a cold reload,
  // and inherently false on the global notifications/home views since they carry
  // no slug). Drives the highlight AND the submenu auto-expand below.
  const routeAgentId = useRouteAgentId()
  const isSelected = agent.slug === routeAgentId
  // Auto-expand on selection only if the agent has content to show. Brand-new
  // agents (no sessions / dashboards yet) start collapsed - the empty submenu
  // would just be visual noise.
  const hasInitialContent =
    (agent.sessionCount ?? 0) > 0 ||
    (agent.dashboards?.length ?? 0) > 0
  const [isOpen, setIsOpen] = useState(isSelected && hasInitialContent)
  // Collapse visually for the duration of a drag so drop targets stay still.
  // `isOpen` itself is untouched, so nothing refetches and the row reopens on
  // drop; only the rendered height changes.
  const isDragActive = useSidebarDragActive()

  // Once the user navigates into a sub-item (session / task / webhook / chat /
  // dashboard) we want the agent's submenu open so the active row is visible.
  // The mount-time `useState` can't catch this — sessionCount is 0 at mount on
  // a freshly-created agent, then jumps to 1 once the first message creates a
  // session. Reactively expand here.
  const isViewingSubItem =
    isSelected &&
    (view.kind === 'session' ||
      view.kind === 'task' ||
      view.kind === 'webhook' ||
      view.kind === 'chat' ||
      view.kind === 'dashboard' ||
      view.kind === 'completedTasks')
  useEffect(() => {
    if (isViewingSubItem) setIsOpen(true)
  }, [isViewingSubItem])
  const [showAll, setShowAll] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const memberCount = agentMemberCount(agent.slug)
  const isShared = isAuthMode && memberCount > 1

  // Lazy-load detail data only when expanded
  const { data: sessions, isLoading: sessionsLoading } = useSessions(isOpen ? agent.slug : null)
  const { data: artifacts } = useArtifacts(isOpen ? agent.slug : null)

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5
  const dashboards = Array.isArray(artifacts) ? artifacts : []
  const avatarState = agentAvatarState(agent, sessions)
  const badgeKind = agentBadgeKind(agent, sessions, isOpen)
  const avatarCutout = badgeKind ? AVATAR_BADGE_CUTOUT[badgeKind] : null

  // Use pre-aggregated counts to determine if the chevron should show.
  // Also show when isOpen (agent selected) since sessions may have been
  // created after the agent list was fetched.
  const hasExpandableContent =
    isOpen ||
    (agent.sessionCount ?? 0) > 0 ||
    (agent.dashboards?.length ?? 0) > 0

  // Show skeleton after 100ms if sessions haven't loaded yet
  useEffect(() => {
    if (!isOpen || !sessionsLoading) {
      setShowSkeleton(false)
      return
    }
    const timer = setTimeout(() => setShowSkeleton(true), 100)
    return () => clearTimeout(timer)
  }, [isOpen, sessionsLoading])

  // Prefetch sessions on hover so expand is instant
  const handleMouseEnter = useCallback(() => {
    if (!isOpen) {
      queryClient.prefetchQuery({
        queryKey: ['sessions', agent.slug],
        queryFn: async () => {
          const res = await apiFetch(`/api/agents/${agent.slug}/sessions`)
          if (!res.ok) throw new Error('Failed to fetch sessions')
          return res.json()
        },
        staleTime: 30_000,
      })
    }
  }, [isOpen, agent.slug, queryClient])

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsOpen((prev) => !prev)
  }

  const { ref: hintRef, hint } = useCmdHintTarget()
  // View-only members can't send, so they get no new-session control; nor
  // does the slot while it shows the ⌘-number hint.
  const canStartSession = hint === null && canUseAgent(agent.slug)
  const warmStartEnabled = useWarmStartOnTypeEnabled()
  const startAgent = useStartAgent()
  const { data: runtimeStatus } = useRuntimeStatus()
  const warmStart = () => {
    if (warmStartEnabled && canStartSession && runtimeStatus?.runtimeReadiness.status === 'READY') {
      startAgent.mutate({ slug: agent.slug, source: 'warm-start' })
    }
  }
  const dragHandlers = useSidebarFileDrop({
    kind: 'agent',
    agentSlug: agent.slug,
    displaySlug: agent.displaySlug,
  })

  return (
    <Collapsible asChild open={isOpen && !isDragActive} onOpenChange={setIsOpen}>
      <SidebarMenuItem
        ref={ref}
        style={style}
        {...rest}
        onMouseEnter={handleMouseEnter}
        // Portaled menus bubble through React, but are outside the draggable row.
        onPointerDown={event => {
          if (event.currentTarget.contains(event.target as Node)) rest.onPointerDown?.(event)
        }}
        onKeyDown={event => {
          if (event.currentTarget.contains(event.target as Node)) rest.onKeyDown?.(event)
        }}
      >
        <AgentContextMenu agent={agent}>
          <SidebarMenuButton
            asChild
            isActive={isSelected}
            className={cn('group/agent-row relative h-11 gap-1.5 overflow-visible pl-[50px]', SIDEBAR_FILE_DROP_CUE)}
          >
            <div {...dragHandlers}>
              {/* Stretch the native link across the row; the roster and
                  chevron sit above it as separate interactive controls. */}
              <AppLink
                ref={hintRef}
                to="/agents/$slug"
                params={{ slug: agent.displaySlug }}
                data-testid={`agent-item-${agent.slug}`}
                data-active={isSelected}
                className="min-w-0 outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-sidebar-ring"
              >
                <span className="block truncate text-[13px] font-normal text-sidebar-foreground">{agent.name}</span>
                {/* While the avatar carries a badge, the second line says what
                    that notification says instead of when the agent last ran. */}
                {badgeKind && agent.notificationPreview ? (
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground/60" data-testid={`agent-notification-preview-${agent.slug}`}>
                    {agent.notificationPreview}
                  </span>
                ) : (
                  <AgentLastRun date={agent.lastActivityAt} />
                )}
              </AppLink>
              {isShared && <SidebarMemberIndicator agentSlug={agent.slug} agentName={agent.name} memberCount={memberCount} selected={isSelected} />}
              {/* The 3-dot button and the status slot travel together, so the
                  slot holds the right edge whether or not the button shows
                  (touch never shows it). */}
              <span className="relative z-10 ml-auto flex shrink-0 items-center">
                {hint === null && (
                  <ContextMenuMoreButton
                    label={`Options for ${agent.name}`}
                    // Spill to the right: a dropdown here would cover the rows below.
                    anchor="beside"
                    data-testid={`agent-menu-button-${agent.slug}`}
                    iconClassName="h-3.5 w-3.5"
                    // Left of the status slot, so the pen that takes over the
                    // slot doesn't move; no width until revealed, so a long name
                    // keeps its room. mr-1.5 clears the pen, which overhangs the
                    // w-4 slot by 4px.
                    className="w-0 overflow-hidden text-muted-foreground hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring menu-revealed:mr-1.5 menu-revealed:w-6"
                  />
                )}
                {/* The trailing slot holds the new-session control: hovering the
                    row (or focusing the button) shows a pen opening the session
                    view with an empty composer. Status lives on the avatar (its
                    motion and AgentAvatarBadge), so the slot is otherwise empty
                    but for the ⌘-number hint. */}
                <span className="group/status-slot relative flex shrink-0 items-center">
                  {/* Sits above the stretched link while keeping clicks
                      (including modifier clicks) native agent navigation. */}
                  <AppLink
                    to="/agents/$slug"
                    params={{ slug: agent.displaySlug }}
                    tabIndex={-1}
                    aria-label={`Open ${agent.name}`}
                    className={cn(
                      'flex items-center transition-opacity',
                      canStartSession && 'group-hover/agent-row:opacity-0 group-focus-within/status-slot:opacity-0'
                    )}
                  >
                    {hint !== null ? <CmdHintBadge hint={hint} /> : <span className="w-4" />}
                  </AppLink>
                  {canStartSession && (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <AppLink
                            to="/agents/$slug/sessions/new"
                            params={{ slug: agent.displaySlug }}
                            onPointerDown={(event) => { if (event.button === 0) warmStart() }}
                            onClick={(event) => { if (event.detail === 0) warmStart() }}
                            aria-label={`New session with ${agent.name}`}
                            data-testid={`agent-new-session-${agent.slug}`}
                            className="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-hover/agent-row:opacity-100"
                          >
                            <SquarePen className="h-3.5 w-3.5" />
                          </AppLink>
                        </TooltipTrigger>
                        <TooltipContent side="right">New session</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </span>
              </span>
              {/* The avatar holds the expand slot; hovering it (or focusing
                  the toggle) swaps in the chevron, Notion-style, on the same 24px
                  hover square as the new-session pen (the ::before). */}
              {hasExpandableContent ? (
                <button
                  type="button"
                  onClick={handleChevronClick}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                  aria-expanded={isOpen}
                  className="group/avatar absolute left-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded outline-none before:absolute before:inset-1 before:rounded hover:before:bg-sidebar-foreground/10 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                >
                  <AvatarCutout cutout={avatarCutout}>
                    <AgentAvatar
                      agent={agent}
                      state={avatarState}
                      size={AGENT_AVATAR_SIZE}
                      followPointer={SIDEBAR_FOLLOW_REGION}
                      className="transition-opacity group-hover/avatar:opacity-0 group-focus-visible/avatar:opacity-0"
                    />
                  </AvatarCutout>
                  <AgentAvatarBadge
                    agent={agent}
                    sessions={sessions}
                    isOpen={isOpen}
                    className={cn(agent.avatar && 'transition-opacity group-hover/avatar:opacity-0 group-focus-visible/avatar:opacity-0')}
                  />
                  <ChevronRight
                    className={cn(
                      'absolute h-3.5 w-3.5 text-sidebar-foreground transition-[opacity,transform]',
                      agent.avatar && 'opacity-0 group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100',
                      isOpen && !isDragActive && 'rotate-90'
                    )}
                  />
                </button>
              ) : (
                <span className="pointer-events-none absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center">
                  <AvatarCutout cutout={avatarCutout}>
                    <AgentAvatar agent={agent} state={avatarState} size={AGENT_AVATAR_SIZE} followPointer={SIDEBAR_FOLLOW_REGION} />
                  </AvatarCutout>
                  <AgentAvatarBadge agent={agent} sessions={sessions} isOpen={isOpen} />
                </span>
              )}
            </div>
          </SidebarMenuButton>
        </AgentContextMenu>
        {hasExpandableContent ? (
          <>
            <CollapsibleContent>
              <SidebarMenuSub className={cn('pb-2 pl-[29px]', SIDEBAR_TREE_CONNECTORS)}>
                {isOpen && sessionsLoading && showSkeleton ? (
                  <SessionsSkeleton />
                ) : (
                  <>
                    {/* Dashboards */}
                    {dashboards.map((artifact) => (
                      <DashboardSubItem
                        key={artifact.slug}
                        artifact={artifact}
                        agentSlug={agent.slug}
                      />
                    ))}
                    {/* Regular sessions */}
                    {visibleSessions?.map((session) => (
                      <SessionSubItem
                        key={session.id}
                        session={session}
                        agentSlug={agent.slug}
                      />
                    ))}
                    {hasMore && (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          asChild
                          className="text-muted-foreground"
                        >
                          <button
                            onClick={() => setShowAll((prev) => !prev)}
                            className="w-full"
                          >
                            <span>
                              {showAll ? 'Show less' : `Show all (${sessions?.length})`}
                            </span>
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )}
                  </>
                )}
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        ) : null}
      </SidebarMenuItem>
    </Collapsible>
  )
})
AgentMenuItemInner.displayName = 'AgentMenuItem'

/**
 * Memoized so that dnd-kit's per-tick context churn stops at the sortable
 * wrapper. During a drag, dnd-kit publishes a new internal context value on
 * essentially every pointer tick, which re-renders every `useSortable`
 * consumer — that is every row wrapper in the list. This row's subtree is the
 * expensive part (a Radix context menu, a mounted-but-closed settings dialog,
 * three alert dialogs, session queries), so the wrapper must be able to bail
 * before reaching it. All of the wrapper's props are referentially stable
 * across those ticks — dnd-kit memoizes `attributes` and `listeners`, and the
 * wrapper memoizes `style` — so a plain identity memo holds. Profiled: without
 * this, a 40-agent list spends whole frames (60–90ms) re-rendering rows whose
 * output cannot change.
 */
export const AgentMenuItem = React.memo(AgentMenuItemInner)

if (__RENDER_TRACKING__) {
  (SessionSubItem as any).whyDidYouRender = true;
  (AgentMenuItem as any).whyDidYouRender = true
}

/**
 * `ids`, keeping the previous array's identity while the ids and their order
 * are unchanged. dnd-kit's SortableContext keys its context value on the
 * identity of `items`, and a new value re-renders every `useSortable` row
 * beneath it — on each agents refetch, every row in the section, since the
 * list is rebuilt whenever any agent changes.
 */
function useSortableIds(ids: string[]): string[] {
  const key = ids.join('\n')
  return useMemo(() => (key ? key.split('\n') : []), [key])
}

/** One section's sortable member list. */
function SectionAgentList({ agents }: { agents: ApiAgent[] }) {
  const items = useSortableIds(agents.map((a) => a.slug))
  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {agents.map((agent) => (
        <SortableAgentMenuItem key={agent.slug} agent={agent} />
      ))}
    </SortableContext>
  )
}

function NotificationsMenuButton() {
  const { data: countData } = useUnreadNotificationCount()
  const { data: platformCountData } = usePlatformUnreadCount()
  const unreadCount = (countData?.count ?? 0) + (platformCountData?.count ?? 0)
  const unreadMentions = countData?.mentions ?? 0
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isActive = pathname === '/notifications'

  return (
    <SidebarMenuButton asChild data-testid="notifications-button" isActive={isActive}>
      <AppLink to="/notifications">
        <Bell className="h-4 w-4" />
        <span>Notifications</span>
        {unreadMentions > 0 ? (
          <UnreadDot mention className="ml-auto" />
        ) : unreadCount > 0 && (
          <span
            className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-500"
            aria-label={`${unreadCount} unread`}
          />
        )}
      </AppLink>
    </SidebarMenuButton>
  )
}

/**
 * The Todo board (the `todo-board` experiment). Like Notifications, it
 * carries a dot when something wants you — here, an agent waiting on your
 * input — so it is visible from anywhere.
 */
function TodoMenuButton() {
  const { data: todos } = useTodos()
  const needsInput = todos?.filter((t) => t.column === 'needs_input').length ?? 0
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <SidebarMenuButton asChild data-testid="todo-button" isActive={pathname === '/todo'}>
      <AppLink to="/todo">
        <ListTodo className="h-4 w-4" />
        <span>Todo</span>
        {needsInput > 0 && (
          <span
            className="ml-auto h-1.5 w-1.5 rounded-full bg-orange-500"
            aria-label={`${needsInput} waiting on your input`}
          />
        )}
      </AppLink>
    </SidebarMenuButton>
  )
}

function findTeamBrainAgent(agents: ApiAgent[]): ApiAgent | undefined {
  return agents.find((agent) => agent.teamBrain)
}

/**
 * Team Brain (the `team-brain` experiment): its page, the pitch and set-up or,
 * once set up, its home page; lit there and in its agent's sessions. The row
 * carries Explore's "New" badge until opened or set up.
 */
function TeamBrainMenuButton() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data: brainAgent } = useAgents({ select: findTeamBrainAgent, poll: false })
  const visited = pathname === '/team-brain' || (!!brainAgent && pathname.startsWith(`/agents/${brainAgent.displaySlug}`))
  const [seen] = useState(() => localStorage.getItem(TEAM_BRAIN_SEEN_KEY) === '1')
  useEffect(() => {
    if (visited) localStorage.setItem(TEAM_BRAIN_SEEN_KEY, '1')
  }, [visited])

  const label = (
    <>
      <Brain className="h-4 w-4" />
      <span>Team Brain</span>
      {!seen && !visited && !brainAgent && (
        <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-white">
          New
        </span>
      )}
    </>
  )
  return (
    <SidebarMenuButton asChild data-testid="team-brain-button" isActive={visited}>
      <AppLink to="/team-brain">{label}</AppLink>
    </SidebarMenuButton>
  )
}

const userMenuItemClassName =
  'flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-sm hover:bg-accent transition-colors disabled:opacity-60'

/**
 * The footer's primary button. With a signed-in user it is their avatar and
 * name, opening a popover that holds Settings and sign out; without one (local
 * mode) it is the plain Settings button.
 */
function UserMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { isAuthMode, user, signOut } = useUser()
  // Go through the same switch path as the sidebar's control rather than
  // calling switchTarget directly: it owns the failure handling, so a switch
  // that cannot be recorded reports itself instead of rejecting into nothing.
  const { switching, switchTo } = useTargetSwitch()
  const [open, setOpen] = useState(false)
  if (!isAuthMode || !user) {
    return (
      <SidebarMenuButton
        onClick={onOpenSettings}
        className="w-auto"
        style={{ paddingLeft: AGENT_AVATAR_LEFT }}
        data-testid="settings-button"
      >
        <Settings className="h-4 w-4" />
        <span>Settings</span>
      </SidebarMenuButton>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarMenuButton
          className="w-auto min-w-0"
          style={{ paddingLeft: AGENT_AVATAR_LEFT }}
          data-testid="user-menu-trigger"
        >
          <UserAvatar user={user} size={20} />
          <span className="truncate">{user.name || user.email}</span>
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-48 p-1">
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onOpenSettings()
          }}
          className={userMenuItemClassName}
          data-testid="settings-button"
        >
          <Settings className="h-4 w-4" />
          Settings
        </button>
        <div className="-mx-1 my-1 h-px bg-border" role="separator" />
        {hasInteractiveLogin() ? (
          <button
            type="button"
            onClick={signOut}
            className={userMenuItemClassName}
            data-testid="sign-out-button"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        ) : (
          // Cloud workspace: signing out would revoke the deployment session
          // the desktop's grant is bound to — disruptive, and pointless since
          // main still holds the platform connection and would just mint
          // another. Offer the action that actually means something here.
          <button
            type="button"
            onClick={() => void switchTo('local')}
            disabled={switching}
            className={userMenuItemClassName}
            data-testid="switch-to-local-button"
          >
            <LogOut className="h-4 w-4" />
            Use this computer
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Shows API key warning only for admins (who can actually fix it).
 * Isolated to avoid calling useSettings() for non-admin users.
 */
function ApiKeyWarning({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { isAuthMode, isAdmin } = useUser()
  const showAdminInfo = !isAuthMode || isAdmin
  const { data: settings } = useSettings({ enabled: showAdminInfo })
  const { data: modelSettings } = useModelSettings()
  const selectedConnection = modelSettings?.connections?.find(
    connection => connection.id === modelSettings.defaultSelection?.llmProviderId
  )

  const activeProviderId = settings?.llmProvider ?? 'anthropic'
  const activeKeyStatus = selectedConnection ?? settings?.apiKeyStatus?.[activeProviderId as keyof typeof settings.apiKeyStatus]
  if (!showAdminInfo || !activeKeyStatus || activeKeyStatus.isConfigured) return null

  return (
    <div className="px-2 pb-2">
      <Alert
        variant="destructive"
        className="py-2 cursor-pointer hover:bg-destructive/20 transition-colors"
        onClick={onOpenSettings}
      >
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          No API key configured.{' '}
          <span className="underline">Click to set up</span>
        </AlertDescription>
      </Alert>
    </div>
  )
}

function HistoryNavigationButtons() {
  const { canGoBack, canGoForward, back, forward } = useHistoryNavigation()
  const buttonClassName =
    'h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors ' +
    'hover:bg-foreground/10 hover:text-foreground disabled:cursor-default disabled:text-muted-foreground/30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/30'

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={back}
            disabled={!canGoBack}
            aria-label="Back"
            className={buttonClassName}
            data-testid="history-back-button"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Back</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={forward}
            disabled={!canGoForward}
            aria-label="Forward"
            className={buttonClassName}
            data-testid="history-forward-button"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Forward</TooltipContent>
      </Tooltip>
    </>
  )
}

export function AppSidebar() {
  useRenderTracker('AppSidebar')
  const { openSettings } = useDialogs()
  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()
  const updateStatus = useUpdateStatus()
  const updateAvailable = updateStatus.state === 'available' || updateStatus.state === 'downloaded'

  // The "New Agent" menu command is handled centrally by MenuCommandHandler
  // (which calls createUntitledAgent); the sidebar keeps the hook for its own
  // "+" button below.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { openSearch } = useSearch()
  const isMobile = useIsMobile()
  const { setOpenMobile } = useSidebar()
  // On mobile the sidebar is an off-canvas Sheet that doesn't auto-close on
  // navigation. Collapse it whenever the location changes (pathname OR search,
  // so selecting a session also closes it) — desktop is unaffected.
  const locationHref = useRouterState({ select: (s) => s.location.href })
  useEffect(() => {
    if (isMobile) setOpenMobile(false)
  }, [locationHref, isMobile, setOpenMobile])
  const { data: agents, isLoading, error } = useListedAgents()
  // Whether to offer Explore is two round trips deep — skillsets, and only then
  // the discoverable agents they contain — so the item arrives after the rest of
  // the nav and pushes it down on the way in. Remember the last answer for this
  // Superagent and show that until the real one lands; `null` means "still
  // asking", which is not the same as "no" and must not render as one.
  const { data: skillsets } = useSkillsets()
  const { data: discoverableAgents } = useDiscoverableAgents()
  const marketplaceAnswer =
    skillsets === undefined
      ? null
      : skillsets.length === 0
        ? false // no skillsets, so the discoverable query never runs at all
        : discoverableAgents === undefined
          ? null
          : discoverableAgents.length > 0
  const hasMarketplace = useRememberedFlag('marketplace', marketplaceAnswer)
  const todoBoardEnabled = useExperiment('todo-board')
  const teamBrainEnabled = useExperiment('team-brain')
  const exploreVisited = pathname === '/explore' || pathname.startsWith('/explore/')
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
  const { data: platformAuth } = usePlatformAuthStatus()
  const isCloud = targetIsRemote()
  const desktopVersion = __APP_VERSION__
  const versionState = resolveSidebarVersionState({
    desktopVersion,
    cloudVersion: isCloud ? runtimeStatus?.appVersion : undefined,
    feedVersion: updateAvailable ? updateStatus.version : undefined,
  })
  const isFullScreen = useFullScreen()

  // macOS fires `enter-full-screen` only after its ~700ms zoom animation completes;
  // by that frame, React + the CSS transition would both kick on the same paint and
  // the collapse goes invisible. Lag the value by one rAF so the renderer paints the
  // pre-transition state first, giving the browser a real "from" frame to animate from.
  const [animatedFullScreen, setAnimatedFullScreen] = useState(isFullScreen)
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimatedFullScreen(isFullScreen))
    return () => cancelAnimationFrame(id)
  }, [isFullScreen])

  // Drag-and-drop sensors: distance threshold prevents click conflicts
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  )

  // ─── Agent list tree (order + folders) ────────────────────────────────────
  //
  // The left nav is one ordered list in which unfiled agents and folders sit
  // side by side, so a folder can be placed anywhere among them. That order
  // cannot be derived from agentOrder — an empty folder has no member to sit
  // behind — so it has a field of its own. agentOrder is still written on every
  // change as the flat reading order, which is what the home grid, the graph
  // and the tray read without knowing folders exist.

  // Optimistic copy of the fields the tree is built from. Held from the first
  // drag movement until the settings write settles, so the list never flashes
  // back to its pre-drag shape.
  const [localTree, setLocalTree] = useState<AgentTreeSettings | null>(null)
  const [localCollapsed, setLocalCollapsed] = useState<string[] | null>(null)
  // Last-write token for localCollapsed, same job as pendingTreeRef below.
  const pendingCollapsedRef = React.useRef<string[] | null>(null)
  // The folder a just-created row should open in rename mode.
  const [pendingRenameFolderId, setPendingRenameFolderId] = useState<string | null>(null)
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null)
  // The insertion point for a live folder drag. Computed by collision
  // detection (which alone knows the pointer's half of the target block) and
  // read both by the blocks (to place the insert line) and by the drop handler
  // — one source of truth is what keeps the line honest about the landing
  // spot. Collision detection runs in DndContext's RENDER (it may only write
  // the ref — a setState there is a render-phase update of this component),
  // so the state the insert line renders from is committed one step later by
  // onDragMove, which fires from an effect after every render whose drag
  // translate changed — i.e. after every render that recomputed the cue.
  const [folderDropCue, setFolderDropCue] = useState<FolderDropCue | null>(null)
  const folderDropCueRef = React.useRef<FolderDropCue | null>(null)
  const commitFolderDropCue = useCallback(() => {
    setFolderDropCue((prev) => {
      const next = folderDropCueRef.current
      if (prev?.folderId === next?.folderId && prev?.edge === next?.edge) return prev
      return next
    })
  }, [])
  const clearFolderDropCue = useCallback(() => {
    folderDropCueRef.current = null
    setFolderDropCue(null)
  }, [])

  const effectiveOrder = localTree?.agentOrder ?? userSettings?.agentOrder
  const effectiveFolders = localTree?.agentFolders ?? userSettings?.agentFolders
  const effectiveAssignments =
    localTree?.agentFolderAssignments ?? userSettings?.agentFolderAssignments
  const effectiveListOrder = localTree?.agentListOrder ?? userSettings?.agentListOrder
  const collapsedFolders = localCollapsed ?? userSettings?.collapsedAgentFolders

  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], effectiveOrder),
    [agents, effectiveOrder]
  )
  const sections = useMemo(
    () => buildFolderSections(orderedAgents, effectiveFolders, effectiveAssignments, effectiveListOrder),
    [orderedAgents, effectiveFolders, effectiveAssignments, effectiveListOrder]
  )
  const sectionSortableIds = useSortableIds(sections.map((s) => sortableIdForFolder(s.folder.id)))
  const hasFolders = (effectiveFolders?.length ?? 0) > 0

  // Drag handlers fire between renders, so they read the sections through a
  // ref rather than a closed-over render value — two pointer moves can land
  // before React has re-derived `sections` from the state the first one set.
  const sectionsRef = React.useRef(sections)
  sectionsRef.current = sections
  // The raw agent list for the write-time rebase in writeTree below, which
  // rebuilds sections from the settings as of when the mutation runs.
  const agentsRef = React.useRef<ApiAgent[]>([])
  agentsRef.current = agents ?? []
  // Whether this drag has actually changed anything, so a drag that ends where
  // it started does not write settings.
  const dragDirtyRef = React.useRef(false)
  // Whether a drag is in progress right now. Mirrors `activeDrag` for the
  // settle callbacks below, which fire between renders.
  const activeDragRef = React.useRef(false)
  // Guards against an earlier write settling while a later one is still in
  // flight and clearing its optimistic view.
  const pendingTreeRef = React.useRef<AgentTreeSettings | null>(null)

  const writeTree = useCallback((
    optimistic: AgentTreeSettings & { collapsedAgentFolders?: string[] },
    operation: TreeOperation
  ) => {
    pendingTreeRef.current = optimistic
    setLocalTree(optimistic)
    updateSettings.mutate(
      (current) => {
        // Re-derive the change against the settings as of when this
        // (scope-serialized) mutation actually runs. The drop's sections
        // snapshot goes stale the moment a concurrent write — a folder
        // create, a rename, a context-menu filing — lands first, and writing
        // the snapshot back would replace agentFolders, assignments and
        // order wholesale, silently undoing that work. The snapshot stays
        // exactly right for the optimistic paint above, and with nothing in
        // flight the rebase reproduces it byte for byte (the operation
        // records the moved thing's FINAL position).
        const sections = buildFolderSections(
          applyAgentOrder(agentsRef.current, current?.agentOrder),
          current?.agentFolders,
          current?.agentFolderAssignments,
          current?.agentListOrder
        )
        const rebased = sectionsToSettings(applyTreeOperation(sections, operation))
        if (operation.kind !== 'dissolveFolder') return rebased
        return {
          ...rebased,
          collapsedAgentFolders: (current?.collapsedAgentFolders ?? []).filter(
            (id) => id !== operation.folderId
          ),
        }
      },
      {
        onError: () => {
          // Settings writes deliberately skip the global error toast, but a
          // drag is a big gesture to lose without a word — the tree is about
          // to snap back to its server shape.
          toast.error("Couldn't save the new layout")
        },
        onSettled: () => {
          if (pendingTreeRef.current !== optimistic) return
          pendingTreeRef.current = null
          // A newer drag may be holding its own mid-drag re-parent in
          // localTree; clearing it now would snap the dragged row back to its
          // source folder for the rest of that drag (over-change events only
          // fire when `over` CHANGES, so nothing would restore it). The
          // drag's own end/cancel paths reset localTree instead.
          if (!activeDragRef.current) setLocalTree(null)
        },
      }
    )
  }, [updateSettings])


  // Prefer whatever the pointer is directly inside, falling back to rect
  // overlap when a fast drag has outrun every droppable. Then bias toward the
  // kind of thing being dragged: an agent aims at rows (which carry a real
  // insertion index), a folder aims at other folders' slots.
  //
  // Two rules on top of that:
  //
  // The dragged agent's CURRENT folder is sticky. Live re-parenting reshapes
  // the list — pulling the row out shrinks the folder, which moves the very
  // boundary the pointer just crossed, which re-parents it straight back — so
  // a within-folder sort near the folder's edge used to flicker in and out of
  // it. While the pointer remains inside the folder block's rect, only targets
  // inside that folder are eligible; leaving the rect really does mean leaving
  // the folder, and by then the shrink moves the boundary AWAY from the
  // pointer, so it cannot oscillate. In sticky mode the gap between two member
  // rows (where nothing row-like is under the pointer) snaps to the nearest
  // member row, so the sort preview never resets mid-gap and the folder never
  // lights up as a drop target for a row it already holds.
  //
  // A dragged FOLDER over an agent row is promoted to that row's section
  // header: the drop takes the whole section's slot, so the header — where the
  // insert line renders — is what `over` should report, not the row.
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const activeType = args.active.data.current?.type
    const pointerHits = pointerWithin(args)
    let collisions = pointerHits.length > 0 ? pointerHits : rectIntersection(args)
    const wantedType = activeType === 'folder' ? 'folder' : 'agent'
    const typeOf = (id: UniqueIdentifier) =>
      args.droppableContainers.find((d) => d.id === id)?.data.current?.type

    if (activeType === 'agent' && args.pointerCoordinates) {
      const location = locateAgent(sectionsRef.current, String(args.active.id))
      const section = location ? sectionsRef.current[location.sectionIndex] : null
      if (section) {
        const blockRect = args.droppableContainers.find(
          (d) => d.id === sortableIdForFolder(section.folder.id)
        )?.rect.current
        const { x, y } = args.pointerCoordinates
        // The vertical grace band absorbs boundary jitter that is not the
        // user's doing: while dnd-kit auto-scrolls, the block slides under a
        // stationary pointer a few px per tick, and without the band each
        // tick at the edge re-parents the row out and back in.
        const grace = 8
        if (
          blockRect &&
          x >= blockRect.left && x <= blockRect.right &&
          y >= blockRect.top - grace && y <= blockRect.bottom + grace
        ) {
          const inside = new Set<string>([
            sortableIdForFolder(section.folder.id),
            containerIdForFolder(section.folder.id),
            ...section.agents.map((a) => a.slug),
          ])
          const filtered = collisions.filter((c) => inside.has(String(c.id)))
          if (filtered.length > 0) collisions = filtered
          if (!collisions.some((c) => typeOf(c.id) === 'agent')) {
            const memberRows = args.droppableContainers.filter((d) => {
              if (!section.agents.some((a) => a.slug === String(d.id))) return false
              // A collapsed folder's member rows stay mounted but hidden, and
              // a hidden row measures 0×0 — inert for the containment and
              // overlap detectors above, but a perfectly good candidate for a
              // DISTANCE snap, which would steal `over` from the header and
              // land the drop at the hidden row's index instead of appending.
              const rect = d.rect.current
              return !!rect && rect.width > 0 && rect.height > 0
            })
            const closest = closestCenter({ ...args, droppableContainers: memberRows })
            if (closest.length > 0) return [closest[0]]
          }
        }
      }
    }

    if (wantedType === 'folder') {
      // Resolve the drag to a target BLOCK: a direct hit, an agent row
      // promoted to its section, or — in the empty sidebar area above the
      // first block or below the last — the nearest outermost block. Then the
      // pointer's half of that block decides which edge the folder lands on;
      // the cue drives both the insert line and the drop itself.
      const blockOf = (id: UniqueIdentifier) =>
        args.droppableContainers.find((d) => d.id === id)

      let target = collisions.find((c) => typeOf(c.id) === 'folder')
      if (!target) {
        const rowHit = collisions.find((c) => typeOf(c.id) === 'agent')
        const location = rowHit ? locateAgent(sectionsRef.current, String(rowHit.id)) : null
        if (location) {
          target = {
            id: sortableIdForFolder(sectionsRef.current[location.sectionIndex].folder.id),
          }
        }
      }
      if (!target && args.pointerCoordinates) {
        const blocks = args.droppableContainers
          .filter((d) => d.data.current?.type === 'folder' && d.rect.current)
          .sort((a, b) => a.rect.current!.top - b.rect.current!.top)
        if (blocks.length > 0) {
          const y = args.pointerCoordinates.y
          const first = blocks[0]
          const last = blocks[blocks.length - 1]
          if (y <= first.rect.current!.top) target = { id: first.id }
          else if (y >= last.rect.current!.bottom) target = { id: last.id }
        }
      }

      if (target) {
        const rect = blockOf(target.id)?.rect.current
        const y = args.pointerCoordinates?.y
        const folderId = String(target.id).replace('agent-folder::', '')
        if (rect && y !== undefined) {
          // Ref only — this runs during render; onDragMove commits it.
          folderDropCueRef.current = {
            folderId,
            edge: y < rect.top + rect.height / 2 ? 'above' : 'below',
          }
        }
        return [target]
      }
      folderDropCueRef.current = null
      return collisions
    }

    if (collisions.length === 0) return collisions
    const preferred = collisions.find((c) => typeOf(c.id) === wantedType)
    return preferred ? [preferred] : collisions
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    dragDirtyRef.current = false
    activeDragRef.current = true
    const data = event.active.data.current
    clearFolderDropCue()
    if (data?.type === 'folder') {
      const section = sectionsRef.current.find((s) => s.folder.id === data.folderId)
      setActiveDrag({
        type: 'folder',
        label: section?.folder.name ?? 'Section',
        folderId: String(data.folderId),
      })
      return
    }
    const slug = String(event.active.id)
    const agent = sectionsRef.current
      .flatMap((s) => s.agents)
      .find((a) => a.slug === slug)
    setActiveDrag({ type: 'agent', label: agent?.name ?? slug })
  }, [clearFolderDropCue])

  // Move an agent between containers live, so the row is already sitting in its
  // new folder before the pointer is released. Reordering inside one container
  // is left to the sortable preview and settled on drop.
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event
    if (!over || active.data.current?.type !== 'agent') return

    const current = sectionsRef.current
    const slug = String(active.id)
    const target = resolveAgentDrop(current, String(over.id))
    const from = locateAgent(current, slug)
    if (!target || !from) return

    if (current[from.sectionIndex].folder.id === target.folderId) return

    const next = moveAgent(current, slug, target)
    if (next === current) return

    sectionsRef.current = next
    dragDirtyRef.current = true
    setLocalTree(sectionsToSettings(next))
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    setActiveDrag(null)
    activeDragRef.current = false
    // Read BEFORE clearing — the cue is what decides where a folder drop
    // lands. Clearing first would silently fall every pointer drop through to
    // the keyboard branch's "take the target's slot" semantics, which only
    // coincides with the cue's promise in two of the four direction/edge
    // quadrants — the insert line would lie in the other two.
    const cue = folderDropCueRef.current
    clearFolderDropCue()

    // Released outside every droppable — treat it as an escape hatch and put
    // the list back the way it was, including any mid-drag move.
    if (!over) {
      setLocalTree(pendingTreeRef.current)
      return
    }

    const current = sectionsRef.current
    const overId = String(over.id)
    let next = current

    if (active.data.current?.type === 'folder') {
      const folderId = String(active.data.current.folderId)
      if (cue) {
        // Insertion-point semantics: land on the cued edge of the cued block.
        // "Take the target's slot" (below) is kept only for keyboard drags,
        // which never produce a pointer-derived cue.
        const from = current.findIndex((s) => s.folder.id === folderId)
        const targetIndex = current.findIndex((s) => s.folder.id === cue.folderId)
        if (from !== -1 && targetIndex !== -1) {
          let insertAt = targetIndex + (cue.edge === 'below' ? 1 : 0)
          if (from < insertAt) insertAt -= 1
          next = moveFolder(current, folderId, insertAt)
        }
      } else {
        const index = resolveFolderDrop(current, overId)
        if (index !== null) next = moveFolder(current, folderId, index)
      }
    } else {
      const target = resolveAgentDrop(current, overId)
      if (target) next = moveAgent(current, String(active.id), target)
    }

    if (next === current && !dragDirtyRef.current) {
      // A drag that ended where it started writes nothing.
      setLocalTree(pendingTreeRef.current)
      return
    }

    // Record the drop as the moved thing's FINAL position in `next`, so the
    // write can re-apply it to whatever the settings say by the time it runs
    // (see writeTree). Deriving from `next` makes the serial case exact.
    let operation: TreeOperation | null = null
    if (active.data.current?.type === 'folder') {
      const folderId = String(active.data.current.folderId)
      const index = next.findIndex((s) => s.folder.id === folderId)
      if (index !== -1) operation = { kind: 'placeFolder', folderId, index }
    } else {
      const slug = String(active.id)
      const location = locateAgent(next, slug)
      if (location) {
        operation = {
          kind: 'placeAgent',
          slug,
          folderId: next[location.sectionIndex].folder.id,
          index: location.memberIndex,
        }
      }
    }
    if (!operation) {
      setLocalTree(pendingTreeRef.current)
      return
    }
    writeTree(sectionsToSettings(next), operation)
  }, [writeTree, clearFolderDropCue])

  /**
   * The shift preview opens a gap by displacing the rows between the dragged
   * item and the one under the pointer, by the dragged item's own height. For
   * an agent row that is a few dozen pixels and reads well. For a folder it is
   * the height of the whole block, which throws the hovered row clear of the
   * pointer, flips the drop target, and lands the folder a slot away from where
   * it was aimed. Folders therefore move without displacing anything, and say
   * where they will land with an insert line instead.
   */
  const topLevelStrategy = useCallback<SortingStrategy>(
    (args) => (activeDrag?.type === 'folder' ? null : verticalListSortingStrategy(args)),
    [activeDrag?.type]
  )

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null)
    activeDragRef.current = false
    clearFolderDropCue()
    setLocalTree(pendingTreeRef.current)
  }, [clearFolderDropCue])

  // ─── Folder CRUD ──────────────────────────────────────────────────────────

  // Create and rename replace `agentFolders` wholesale, so they use the
  // updater form: the folder list is read when the (scope-serialized)
  // mutation runs, not when the click happened — a payload snapshotted at
  // click time would revert whatever folder write was still in flight.
  const handleCreateFolder = useCallback(() => {
    const id = newFolderId()
    // Created from "Add section" at the end of the list, so the new one goes
    // last — right above the button, where its rename input opens.
    setPendingRenameFolderId(id)
    updateSettings.mutate((current) => {
      const folders = sanitizeFolders(current?.agentFolders)
      const marker = sortableIdForFolder(id)
      const order = (current?.agentListOrder ?? []).filter((key) => key !== marker)
      // An untouched install has no stored places yet; write the default
      // folder's too, or it would keep defaulting ahead of everything (-1)
      // regardless of where it was shown.
      const rootMarker = sortableIdForFolder(ROOT_FOLDER_ID)
      const withRoot = order.includes(rootMarker) ? order : [rootMarker, ...order]
      return {
        agentFolders: [...folders, { id, name: uniqueFolderName(folders) }],
        agentListOrder: [...withRoot, marker],
      }
    })
  }, [updateSettings])

  const handleRenameFolder = useCallback((folderId: string, name: string) => {
    updateSettings.mutate((current) => ({
      agentFolders: sanitizeFolders(current?.agentFolders).map((f) =>
        f.id === folderId ? { ...f, name } : f
      ),
    }))
  }, [updateSettings])

  const handleDeleteFolder = useCallback((folderId: string) => {
    const current = sectionsRef.current
    const next = dissolveFolder(current, folderId)
    if (next === current) return
    writeTree(
      {
        ...sectionsToSettings(next),
        collapsedAgentFolders: (collapsedFolders ?? []).filter((id) => id !== folderId),
      },
      { kind: 'dissolveFolder', folderId }
    )
  }, [collapsedFolders, writeTree])

  const handleToggleFolder = useCallback((folderId: string) => {
    const current = collapsedFolders ?? []
    const next = current.includes(folderId)
      ? current.filter((id) => id !== folderId)
      : [...current, folderId]
    // Collapsing has to feel instant even against a cloud workspace, so paint
    // it locally and let the write catch up. Only the LATEST toggle may clear
    // the optimistic view — with two toggles in flight, the first settling
    // would otherwise drop the second's fold back to the cached state until
    // its own write lands (a visible flap on a slow connection).
    pendingCollapsedRef.current = next
    setLocalCollapsed(next)
    updateSettings.mutate(
      { collapsedAgentFolders: next },
      {
        onSettled: () => {
          if (pendingCollapsedRef.current !== next) return
          pendingCollapsedRef.current = null
          setLocalCollapsed(null)
        },
      }
    )
  }, [collapsedFolders, updateSettings])

  // A folder's own +: the new agent is filed into it, and a collapsed folder
  // opens so the new row is in view when the list refetches. Two settings
  // writes (expand, then the filing inside the hook), serialized by scope.
  const handleCreateAgentInFolder = useCallback((folderId: string) => {
    if (isCreatingAgent) return
    if ((collapsedFolders ?? []).includes(folderId)) handleToggleFolder(folderId)
    void createUntitledAgent({ surface: 'section_plus', folderId })
  }, [isCreatingAgent, collapsedFolders, handleToggleFolder, createUntitledAgent])

  const isOnline = useIsOnline()

  // Windows-only: firewall Block rules against our exe silently kill every
  // container→host connection (browser launch, tool proxies) while the rest
  // of the app works, so surface it here rather than waiting for a failure.
  const { data: firewallStatus } = useFirewallStatus()
  const fixFirewall = useFixFirewall()
  const isFirewallBlocked = !!firewallStatus?.blocked
  const firewallFixState: FirewallFixUiState = fixFirewall.isPending
    ? 'fixing'
    : fixFirewall.data && !fixFirewall.data.ok
      ? fixFirewall.data.reason === 'uac-declined' ? 'declined' : 'failed'
      : 'idle'

  const readiness = runtimeStatus?.runtimeReadiness
  const servicesInitError = runtimeStatus?.servicesInitError ?? null
  const isRuntimeUnavailable = readiness?.status === 'RUNTIME_UNAVAILABLE' || readiness?.status === 'ERROR'
  const isPullingOrBuilding = readiness?.status === 'PULLING_IMAGE'
  const isChecking = readiness?.status === 'CHECKING'

  // macOS windowed is the only case that needs room reserved at the left of the
  // header row; everywhere else (mac fullscreen, Windows, web) the row starts at
  // the sidebar's own padding.
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !animatedFullScreen
  const isWindowsElectron = isElectron() && getPlatform() === 'win32'
  const showHistoryNavigation = !__WEB__ && isElectron()

  return (
    <>
      <Sidebar variant="inset" data-testid="app-sidebar">
      {/*
        The sidebar's title bar: one 48px row holding everything that acts on the
        window rather than on an agent — where agents run, history, search — and,
        on macOS, the traffic lights it leaves room for. The browser restores the
        app name in the space left by the Electron-only target and history
        controls.

        The left padding (not the height) is what changes on a fullscreen
        toggle, so the row itself never moves and only the traffic-light gap
        animates shut.
      */}
      <SidebarHeader
        className="app-drag-region h-12 shrink-0 p-0 transition-[padding-left] duration-200 ease-out"
        style={{ paddingLeft: needsTrafficLightPadding ? '80px' : undefined }}
      >
        <div className="flex items-center h-12 px-2 gap-1">
          {__WEB__ && (
            <span className="shrink-0 select-none text-base font-medium">Gamut</span>
          )}

          {isWindowsElectron && (
            <button
              className="app-no-drag shrink-0 p-0.5 rounded hover:bg-foreground/10 transition-colors cursor-default"
              aria-label="Application menu"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                window.electronAPI?.popupAppMenu(Math.round(rect.left), Math.round(rect.bottom))
              }}
            >
              <ChevronDown className="h-4 w-4 text-foreground/60" />
            </button>
          )}

          {/* Which Superagent this window drives. First in the row, ahead of the
              controls that act within it: it scopes them, and everything below.
              Renders nothing when there is no cloud workspace to switch to. */}
          <TargetSwitcher />

          <div className="app-no-drag ml-auto -mr-2 flex shrink-0 items-center gap-0.5">
            <TooltipProvider delayDuration={200}>
              {showHistoryNavigation && <HistoryNavigationButtons />}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={openSearch}
                    aria-label="Search"
                    className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 transition-colors"
                    data-testid="search-button"
                  >
                    <Search className="h-4 w-4 -translate-y-[1px]" />
                  </button>
                </TooltipTrigger>
                {/* No keyboard on touch, and the Sheet's focus-trap would auto-open
                    this tooltip with no way to dismiss it — so suppress it on mobile. */}
                {!isMobile && (
                  <TooltipContent side="bottom" className="flex items-center gap-2">
                    <span>Search</span>
                    <span className="opacity-70">{getPlatform() === 'darwin' ? '⌘K' : 'Ctrl+K'}</span>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </SidebarHeader>

      <ErrorBoundary compact>
        <SidebarContent className="gap-0 overflow-visible">
          <SidebarGroup className="shrink-0 p-0">
            {/* Status banners — render under the title bar so they sit inside the
                sidebar's content area rather than pushing the header down. The
                SidebarBannerStack wrapper owns horizontal padding, inter-banner
                gap, and trailing space; render it only when at least one banner
                is visible to avoid a stray padded div. */}
            {(!isOnline || isRuntimeUnavailable || isChecking || isPullingOrBuilding || isFirewallBlocked || servicesInitError) && (
              <SidebarBannerStack>
                {!isOnline && <OfflineSidebarBanner />}
                {servicesInitError && <ServicesDegradedSidebarBanner message={servicesInitError} />}
                {isRuntimeUnavailable && (
                  <RuntimeUnavailableSidebarBanner
                    message={readiness?.message}
                    onOpenSettings={() => openSettings('runtime')}
                  />
                )}
                {isChecking && <RuntimeCheckingSidebarBanner message={readiness?.message} />}
                {isPullingOrBuilding && (
                  <RuntimePullingSidebarBanner
                    message={readiness?.message}
                    percent={readiness?.pullProgress?.percent}
                  />
                )}
                {isFirewallBlocked && (
                  <FirewallBlockedSidebarBanner
                    fixState={firewallFixState}
                    onFix={() => fixFirewall.mutate()}
                  />
                )}
              </SidebarBannerStack>
            )}

            <ApiKeyWarning onOpenSettings={() => openSettings('llm')} />
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5 pt-2 pb-0">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    // Route-derived: active only on the exact home route, so it
                    // never lights up on /notifications or an agent route.
                    isActive={pathname === '/'}
                    data-testid="home-button"
                  >
                    <AppLink to="/">
                      <LayoutGrid className="h-4 w-4" />
                      <span>Home</span>
                    </AppLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <NotificationsMenuButton />
                </SidebarMenuItem>
                {todoBoardEnabled && (
                  <SidebarMenuItem>
                    <TodoMenuButton />
                  </SidebarMenuItem>
                )}
                {teamBrainEnabled && (
                  <SidebarMenuItem>
                    <TeamBrainMenuButton />
                  </SidebarMenuItem>
                )}
                {hasMarketplace && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      // Prefix match: the details page (/explore/...) is still Explore.
                      isActive={exploreVisited}
                      data-testid="marketplace-button"
                    >
                      <AppLink to="/explore">
                        <Compass className="h-4 w-4" />
                        <span>Discover New Agents</span>
                      </AppLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => { void createUntitledAgent({ surface: 'nav' }) }}
                    disabled={isCreatingAgent}
                    data-testid="new-agent-button"
                  >
                    <Plus className="h-4 w-4" />
                    <span>New Agent</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup
            className={cn('group/agents-group flex-1 min-h-0 overflow-y-auto p-0', THIN_SCROLLBAR)}
            data-testid="agent-list-scroll"
          >
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {isLoading ? (
                  <>
                    {Array.from({ length: 3 }).map((_, index) => (
                      <SidebarMenuItem key={index}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}
                  </>
                ) : error ? (
                  <div className="px-2 py-4 text-sm text-destructive select-text">
                    Failed to load agents
                  </div>
                ) : !agents?.length && !hasFolders ? (
                  <div className="px-2 py-4 text-sm text-muted-foreground">
                    No agents yet. Create one to get started.
                  </div>
                ) : (
                  <SidebarDragProvider value={activeDrag?.type ?? null}>
                    <DndContext
                      sensors={sensors}
                      collisionDetection={collisionDetection}
                      onDragStart={handleDragStart}
                      onDragMove={commitFolderDropCue}
                      onDragOver={handleDragOver}
                      onDragEnd={handleDragEnd}
                      onDragCancel={handleDragCancel}
                      modifiers={[restrictToVerticalAxis]}
                    >
                      {/*
                        The top level is folders and nothing else — "Your
                        Agents" is the always-present default one, so every
                        agent sits under some header and the headers read as
                        peers. Each folder's members are a nested sortable
                        list of their own.
                      */}
                      <SortableContext
                        items={sectionSortableIds}
                        strategy={topLevelStrategy}
                      >
                        {sections.map((section) => (
                          <AgentFolderBlock
                            key={section.folder.id}
                            folder={section.folder}
                            isRoot={section.isRoot}
                            agentCount={section.agents.length}
                            isCollapsed={(collapsedFolders ?? []).includes(section.folder.id)}
                            activeDragType={activeDrag?.type ?? null}
                            insertEdge={
                              folderDropCue?.folderId === section.folder.id &&
                              activeDrag?.folderId !== section.folder.id
                                ? folderDropCue.edge
                                : null
                            }
                            initialRenaming={section.folder.id === pendingRenameFolderId}
                            onToggle={() => handleToggleFolder(section.folder.id)}
                            onRename={(name) => handleRenameFolder(section.folder.id, name)}
                            onRenameEnd={() => setPendingRenameFolderId(null)}
                            onDelete={() => handleDeleteFolder(section.folder.id)}
                            onCreateAgent={() => handleCreateAgentInFolder(section.folder.id)}
                          >
                            <SectionAgentList agents={section.agents} />
                          </AgentFolderBlock>
                        ))}
                      </SortableContext>
                      <DragOverlay dropAnimation={agentDropAnimation}>
                        {activeDrag ? (
                          <AgentDragOverlayRow
                            label={activeDrag.label}
                            isFolder={activeDrag.type === 'folder'}
                          />
                        ) : null}
                      </DragOverlay>
                    </DndContext>
                  </SidebarDragProvider>
                )}
                {/*
                  Always the last thing in the list, under the sections it
                  adds to, and styled as one of them: a section header's text
                  and chevron-sized icon, spaced like one (mt-2, as on each
                  section's block) so the gaps down the list stay uniform.
                  Unlike a header it is a plain action, so it keeps the menu
                  button's hover fill (the Electron vibrancy rules supply the
                  translucent one there) and its text and + darken on hover.
                */}
                {(agents?.length ?? 0) > 0 && (
                  <SidebarMenuItem className="mt-2">
                    <SidebarMenuButton
                      onClick={handleCreateFolder}
                      className={cn(
                        SECTION_ROW_CLASS,
                        'group/add-section hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent active:text-sidebar-foreground'
                      )}
                      data-testid="add-section-button"
                    >
                      <span className="flex shrink-0 items-center">
                        <Plus className={cn(SECTION_ICON_CLASS, 'group-hover/add-section:text-sidebar-foreground')} />
                      </span>
                      <span>Add section</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ErrorBoundary>

      {/* Full width like the agent rows, so its ends can line up with
          theirs: the user's avatar starts where the agent avatars do (in
          UserMenu), and the version ends 12px in, where the rows' status
          icons end (a 10px icon centred in a 16px slot 8px in). */}
      <SidebarFooter className="border-t p-0 pt-1 pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-between gap-2">
          <UserMenu onOpenSettings={() => openSettings()} />
          {isCloud && versionState.showPair && versionState.cloudVersion ? (
            <div
              className="flex items-center gap-1.5 pl-2 pr-3 text-xs text-muted-foreground shrink-0"
              data-testid="sidebar-version"
            >
              <button
                type="button"
                onClick={() => openSettings('general')}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
                title={`Desktop v${versionState.desktopVersion}`}
                data-testid="sidebar-version-desktop"
              >
                <Laptop className="mr-0.5 size-3" aria-hidden="true" />
                {versionState.desktopVersion}
                {versionState.desktopBehind && (
                  <VersionBehindDot
                    wayBehind={versionState.desktopWayBehind}
                    label="Desktop update available"
                  />
                )}
              </button>
              <span className="h-2.5 w-px bg-current opacity-60" aria-hidden="true" />
              <button
                type="button"
                onClick={() => {
                  const base = platformAuth?.platformBaseUrl
                  const orgId = platformAuth?.orgId
                  if (!base || !orgId) return
                  void openExternalUrl(
                    `${base}/dashboard/organizations/${orgId}?tab=cloud`,
                  )
                }}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
                title={`Cloud v${versionState.cloudVersion}`}
                data-testid="sidebar-version-cloud"
              >
                <Cloud className="mr-0.5 size-3" aria-hidden="true" />
                {versionState.cloudVersion}
                {versionState.cloudBehind && (
                  <VersionBehindDot
                    wayBehind={versionState.cloudWayBehind}
                    label="Cloud update available"
                  />
                )}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => openSettings('general')}
              className="inline-flex items-center gap-1.5 pl-2 pr-3 text-xs text-muted-foreground shrink-0 hover:text-foreground"
              title={updateAvailable ? `${isCloud ? 'Desktop update available' : 'Update available'}: v${updateStatus.version}` : undefined}
              data-testid="sidebar-version"
            >
              <span>{versionState.cloudVersion ?? desktopVersion}</span>
              {updateAvailable && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-blue-500"
                  aria-label={isCloud ? 'Desktop update available' : 'Update available'}
                />
              )}
            </button>
          )}
        </div>
      </SidebarFooter>

      <SidebarRail />
      </Sidebar>
    </>
  )
}

if (__RENDER_TRACKING__) {
  (AppSidebar as any).whyDidYouRender = true
}
