
import { Bell, ChevronDown, ChevronLeft, ChevronRight, Plus, Search, Settings, AlertTriangle, LayoutGrid, SquareMousePointer, LogOut, User, Users, Compass, MoonStar } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from '@shared/lib/utils/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { AppLink } from '@renderer/components/ui/app-link'
import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { isElectron, getPlatform, openDashboardExternal } from '@renderer/lib/env'
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
  SidebarGroupLabel,
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
import { useAgents, useRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSessions, type ApiSession } from '@renderer/hooks/use-sessions'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { WorkingDots, AwaitingDot } from '@renderer/components/agents/status-indicators'
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
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
import { usePlatformUnreadCount } from '@renderer/hooks/use-platform-notifications'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { HoverScrollText } from '@renderer/components/ui/hover-scroll-text'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableAgentMenuItem } from './sortable-agent-item'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import { useRenderTracker } from '@renderer/lib/perf'
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
import { useSkillsets } from '@renderer/hooks/use-skillsets'
import { useRememberedFlag } from '@renderer/hooks/use-remembered-flag'
import { AgentTemplateBrowseDialog } from '@renderer/components/agents/agent-template-browse-dialog'

// 4px-wide thin scrollbar with a muted-foreground/20 thumb. Reused on the
// agents-list group; pull out as a constant so the call site stays readable.
const THIN_SCROLLBAR =
  '[scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)/0.2)_transparent] ' +
  '[&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent ' +
  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20'

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
  const { isStreaming } = useMessageStream(isSelected ? session.id : null, isSelected ? agentSlug : null)
  const isWorking = (session.isActive || isStreaming) && !session.isAwaitingInput
  const isAwaitingInput = session.isAwaitingInput
  const hasUnread = !session.isActive && !session.isAwaitingInput && session.hasUnreadNotifications
  // Pending-wake (long sleep) indicator: shown alongside the unread dot, but
  // suppressed while the session is actively working/awaiting (momentarily
  // redundant — the session clearly isn't asleep).
  const showPendingWake = !!session.pendingWakeAt && !isWorking && !isAwaitingInput
  const { ref: hintRef, hint } = useCmdHintTarget()

  return (
    <SidebarMenuSubItem>
      <SessionContextMenu
        sessionId={session.id}
        sessionName={session.name}
        agentSlug={agentSlug}
      >
        <SidebarMenuSubButton
          asChild
          isActive={isSelected}
        >
          <AppLink
            ref={hintRef}
            to="/agents/$slug/sessions/$sessionId"
            params={{ slug: agentSlug, sessionId: session.id }}
            className="flex items-center gap-2 w-full"
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
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-500" role="img" aria-label="unread notifications" />
                ) : null}
              </span>
            )}
          </AppLink>
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

// Right-side indicator on the agent row.
// Awaiting / working aggregate across sessions regardless of expansion, with
// the same formula as the agent header's AgentStatus (fresh sessions data
// when loaded, agent-level flags as fallback) — the sidebar and the top nav
// render on the same screen and must never disagree about whether an agent
// is working. The unread dot IS still suppressed when expanded: it's a
// sidebar-only navigation aid with no header counterpart, and the session
// rows already point at the unread session.
// Priority: awaiting > working > unread > sleeping/idle.
function AgentRowIndicator({
  agent,
  sessions,
  isOpen,
}: {
  agent: ApiAgent
  sessions: ApiSession[] | undefined
  isOpen: boolean
}) {
  const isAwaiting = sessions?.some((s) => s.isAwaitingInput) || (agent.hasSessionsAwaitingInput ?? false)
  const isWorking = !isAwaiting && (sessions?.some((s) => s.isActive) || (agent.hasActiveSessions ?? false))
  const isUnread = !isOpen && !isAwaiting && !isWorking && (agent.hasUnreadNotifications ?? false)
  if (isUnread) {
    return (
      <span className="flex items-center w-4 justify-center" role="img" aria-label="unread notifications">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
      </span>
    )
  }
  return (
    <AgentStatus
      status={agent.status}
      hasActiveSessions={isWorking}
      hasSessionsAwaitingInput={isAwaiting}
      iconOnly
    />
  )
}

// Agent menu item with expandable sessions
export const AgentMenuItem = React.forwardRef<
  HTMLLIElement,
  { agent: ApiAgent } & React.HTMLAttributes<HTMLLIElement>
>(({ agent, style, ...rest }, ref) => {
  useRenderTracker('AgentMenuItem')
  const { view } = useRouteLocation()
  const { agentMemberCount } = useUser()
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
      view.kind === 'dashboard')
  useEffect(() => {
    if (isViewingSubItem) setIsOpen(true)
  }, [isViewingSubItem])
  const [showAll, setShowAll] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isShared = agentMemberCount(agent.slug) > 1

  // Lazy-load detail data only when expanded
  const { data: sessions, isLoading: sessionsLoading } = useSessions(isOpen ? agent.slug : null)
  const { data: artifacts } = useArtifacts(isOpen ? agent.slug : null)

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5
  const dashboards = Array.isArray(artifacts) ? artifacts : []

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

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
      <SidebarMenuItem ref={ref} style={style} {...rest} onMouseEnter={handleMouseEnter}>
        {/*
          Wrap the row + chevron in a relative box so the absolutely-positioned
          chevron tracks the row height, not the (potentially expanded) menu
          item that also contains CollapsibleContent below.
        */}
        <div className="relative">
          <AgentContextMenu agent={agent}>
            <SidebarMenuButton
              asChild
              isActive={isSelected}
              className="justify-between pl-7"
              data-testid={`agent-item-${agent.slug}`}
            >
              <AppLink ref={hintRef} to="/agents/$slug" params={{ slug: agent.displaySlug }}>
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate text-[13px] font-normal text-sidebar-foreground">{agent.name}</span>
                  {isShared && <Users className="h-3 w-3 shrink-0 text-muted-foreground" />}
                </span>
                {hint !== null ? (
                  <CmdHintBadge hint={hint} />
                ) : (
                  <AgentRowIndicator agent={agent} sessions={sessions} isOpen={isOpen} />
                )}
              </AppLink>
            </SidebarMenuButton>
          </AgentContextMenu>
          {/*
            Sibling chevron button overlays its slot in the row so the row stays a
            single <button> (no nested interactive controls). Only rendered when
            there is expandable content so agents with no sessions or dashboards
            do not show an empty chevron.
          */}
          {hasExpandableContent && (
            <button
              type="button"
              onClick={handleChevronClick}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              aria-expanded={isOpen}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded focus-visible:ring-2 focus-visible:ring-sidebar-ring outline-none"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground/60 transition-[color,transform] group-hover/menu-item:text-sidebar-foreground',
                  isOpen && 'rotate-90'
                )}
              />
            </button>
          )}
        </div>
        {hasExpandableContent ? (
          <>
            <CollapsibleContent>
              <SidebarMenuSub className={cn('pb-2', SIDEBAR_TREE_CONNECTORS)}>
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
AgentMenuItem.displayName = 'AgentMenuItem'

if (__RENDER_TRACKING__) {
  (SessionSubItem as any).whyDidYouRender = true;
  (AgentMenuItem as any).whyDidYouRender = true
}

function NotificationsMenuButton() {
  const { data: countData } = useUnreadNotificationCount()
  const { data: platformCountData } = usePlatformUnreadCount()
  const unreadCount = (countData?.count ?? 0) + (platformCountData?.count ?? 0)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isActive = pathname === '/notifications'

  return (
    <SidebarMenuButton asChild data-testid="notifications-button" isActive={isActive}>
      <AppLink to="/notifications">
        <Bell className="h-4 w-4" />
        <span>Notifications</span>
        {unreadCount > 0 && (
          <span
            className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-500"
            aria-label={`${unreadCount} unread`}
          />
        )}
      </AppLink>
    </SidebarMenuButton>
  )
}

function UserMenu() {
  const { isAuthMode, user, signOut } = useUser()
  // Go through the same switch path as the sidebar's control rather than
  // calling switchTarget directly: it owns the failure handling, so a switch
  // that cannot be recorded reports itself instead of rejecting into nothing.
  const { switching, switchTo } = useTargetSwitch()
  if (!isAuthMode || !user) return null
  return (
    <div className="px-2">
      <Popover>
        <PopoverTrigger asChild>
          <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="user-menu-trigger">
            <User className="h-3 w-3" />
            <span className="truncate max-w-[140px]">{user.name}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1">
          {hasInteractiveLogin() ? (
            <button
              onClick={signOut}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-sm hover:bg-accent transition-colors"
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
              onClick={() => void switchTo('local')}
              disabled={switching}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-sm hover:bg-accent transition-colors disabled:opacity-60"
              data-testid="switch-to-local-button"
            >
              <LogOut className="h-4 w-4" />
              Use this computer
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
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

  const activeProviderId = settings?.llmProvider ?? 'anthropic'
  const activeKeyStatus = settings?.apiKeyStatus?.[activeProviderId as keyof typeof settings.apiKeyStatus]
  if (!activeKeyStatus || activeKeyStatus.isConfigured) return null

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
  const { data: agents, isLoading, error } = useAgents()
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
  const [marketplaceOpen, setMarketplaceOpen] = useState(false)
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
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
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Optimistic local order during mutation
  const [localOrder, setLocalOrder] = useState<string[] | null>(null)
  const effectiveOrder = localOrder ?? userSettings?.agentOrder
  const orderedAgents = useMemo(
    () => applyAgentOrder(agents ?? [], effectiveOrder),
    [agents, effectiveOrder]
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    if (typeof active.id !== 'string' || typeof over.id !== 'string') return

    const currentSlugs = orderedAgents.map(a => a.slug)
    const oldIndex = currentSlugs.indexOf(active.id)
    const newIndex = currentSlugs.indexOf(over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = arrayMove(currentSlugs, oldIndex, newIndex)
    setLocalOrder(newOrder)
    updateSettings.mutate(
      { agentOrder: newOrder },
      { onSettled: () => setLocalOrder(null) }
    )
  }, [orderedAgents, updateSettings])

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
        className="app-drag-region h-12 shrink-0 p-0 overflow-hidden transition-[padding-left] duration-200 ease-out"
        style={{ paddingLeft: needsTrafficLightPadding ? '80px' : undefined }}
      >
        {/* `overflow-hidden` is load-bearing: hovering the target switcher
            expands it in place, which pushes the buttons after it past the right
            edge rather than squeezing them. */}
        <div className="flex items-center h-12 px-2 gap-1 overflow-hidden">
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
        <SidebarContent className="overflow-visible">
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
              <SidebarMenu className="gap-0.5 py-2 pt-0">
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
                {hasMarketplace && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setMarketplaceOpen(true)}
                      data-testid="marketplace-button"
                    >
                      <Compass className="h-4 w-4" />
                      <span>Explore</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => { void createUntitledAgent() }}
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
          <SidebarGroup className={cn('flex-1 min-h-0 overflow-y-auto p-0', THIN_SCROLLBAR)}>
            <SidebarGroupLabel className="mt-0.5 font-normal text-sidebar-foreground/50">Your Agents</SidebarGroupLabel>
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
                ) : !agents?.length ? (
                  <div className="px-2 py-4 text-sm text-muted-foreground">
                    No agents yet. Create one to get started.
                  </div>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                    modifiers={[restrictToVerticalAxis]}
                  >
                    <SortableContext
                      items={orderedAgents.map(a => a.slug)}
                      strategy={verticalListSortingStrategy}
                    >
                      {orderedAgents.map((agent) => (
                        <SortableAgentMenuItem key={agent.slug} agent={agent} />
                      ))}
                    </SortableContext>
                  </DndContext>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </ErrorBoundary>

      <SidebarFooter className="border-t p-0 px-2 pt-1 pb-[env(safe-area-inset-bottom)]">
        <UserMenu />
        <div className="flex items-center justify-between gap-2">
          <SidebarMenuButton
            onClick={() => openSettings()}
            className="w-auto"
            data-testid="settings-button"
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </SidebarMenuButton>
          <button
            type="button"
            onClick={() => openSettings('general')}
            className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground shrink-0 hover:text-foreground"
            title={updateAvailable ? `Update available: v${updateStatus.version}` : undefined}
            data-testid="sidebar-version"
          >
            {updateAvailable && (
              <span className="h-2 w-2 rounded-full bg-blue-500" aria-label="Update available" />
            )}
            <span>v{__APP_VERSION__}</span>
          </button>
        </div>
      </SidebarFooter>

      <SidebarRail />
      </Sidebar>

      <AgentTemplateBrowseDialog open={marketplaceOpen} onOpenChange={setMarketplaceOpen} />
    </>
  )
}

if (__RENDER_TRACKING__) {
  (AppSidebar as any).whyDidYouRender = true
}
