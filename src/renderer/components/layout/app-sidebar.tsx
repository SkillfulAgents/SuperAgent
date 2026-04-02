
import { ChevronRight, Plus, Settings, AlertTriangle, Clock, LayoutDashboard, Loader2, WifiOff, LogOut, User, Users, CircleHelp, Ban } from 'lucide-react'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { isElectron, getPlatform, openDashboardExternal } from '@renderer/lib/env'
import { useDialogs } from '@renderer/context/dialog-context'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@renderer/components/ui/sidebar'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSessions, type ApiSession } from '@renderer/hooks/use-sessions'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { CreateAgentDialog } from '@renderer/components/agents/create-agent-dialog'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { DashboardContextMenu } from '@renderer/components/dashboards/dashboard-context-menu'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useSelection } from '@renderer/context/selection-context'
import { useScheduledTasks, type ApiScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { useArtifacts, type ArtifactInfo } from '@renderer/hooks/use-artifacts'
import { GlobalSettingsDialog } from '@renderer/components/settings/global-settings-dialog'
import { ContainerSetupDialog } from '@renderer/components/settings/container-setup-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useUser } from '@renderer/context/user-context'
import { NotificationBell } from '@renderer/components/notifications/notification-bell'
import { useIsOnline } from '@renderer/context/connectivity-context'
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

// Session sub-item that tracks its streaming state
function SessionSubItem({
  session,
  agentSlug,
}: {
  session: ApiSession
  agentSlug: string
}) {
  useRenderTracker('SessionSubItem')
  const { selectedSessionId, selectAgent, selectSession } = useSelection()
  const isSelected = session.id === selectedSessionId
  const { isStreaming } = useMessageStream(isSelected ? session.id : null, isSelected ? agentSlug : null)
  const isWorking = (session.isActive || isStreaming) && !session.isAwaitingInput
  const isAwaitingInput = session.isAwaitingInput
  const hasUnread = !session.isActive && !session.isAwaitingInput && session.hasUnreadNotifications

  const handleClick = () => {
    selectAgent(agentSlug)
    selectSession(session.id)
  }

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
          <button onClick={handleClick} className="flex items-center gap-2 w-full" data-testid={`session-item-${session.id}`}>
            {isAwaitingInput ? (
              <CircleHelp className="h-3 w-3 shrink-0 text-orange-500" />
            ) : isWorking ? (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-current"></span>
              </span>
            ) : hasUnread ? (
              <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
            ) : null}
            <span className="truncate">{session.name}</span>
          </button>
        </SidebarMenuSubButton>
      </SessionContextMenu>
    </SidebarMenuSubItem>
  )
}

// Scheduled task sub-item
function ScheduledTaskSubItem({
  task,
  agentSlug,
}: {
  task: ApiScheduledTask
  agentSlug: string
}) {
  const { selectedScheduledTaskId, selectAgent, selectScheduledTask } = useSelection()
  const isSelected = task.id === selectedScheduledTaskId

  const handleClick = () => {
    selectAgent(agentSlug)
    selectScheduledTask(task.id)
  }

  // Format tooltip based on task status
  const tooltip = task.status === 'cancelled'
    ? `Cancelled${task.cancelledAt ? ': ' + new Date(task.cancelledAt).toLocaleString() : ''}`
    : `Scheduled for: ${new Date(task.nextExecutionAt).toLocaleString()}`

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isSelected}
        title={tooltip}
      >
        <button
          onClick={handleClick}
          className={`flex items-center gap-2 w-full text-muted-foreground ${task.status === 'cancelled' ? 'opacity-50' : 'opacity-70'}`}
        >
          {task.status === 'cancelled' ? <Ban className="h-3 w-3 shrink-0" /> : <Clock className="h-3 w-3 shrink-0" />}
          <span className="truncate">{task.name || 'Scheduled Task'}</span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

// Collapsible group for multiple scheduled tasks
function ScheduledTasksGroup({
  pendingTasks,
  cancelledTasks,
  agentSlug,
}: {
  pendingTasks: ApiScheduledTask[]
  cancelledTasks: ApiScheduledTask[]
  agentSlug: string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [cancelledOpen, setCancelledOpen] = useState(false)
  const totalCount = pendingTasks.length + cancelledTasks.length

  return (
    <SidebarMenuSubItem>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton asChild>
            <button className="flex items-center gap-2 w-full text-muted-foreground opacity-70">
              <Clock className="h-3 w-3 shrink-0" />
              <span className="truncate">Scheduled Jobs ({totalCount})</span>
              <ChevronRight className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 data-[state=open]:rotate-90" data-state={isOpen ? 'open' : 'closed'} />
            </button>
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {pendingTasks.map((task) => (
              <ScheduledTaskSubItem
                key={task.id}
                task={task}
                agentSlug={agentSlug}
              />
            ))}
            {cancelledTasks.length > 0 && (
              <SidebarMenuSubItem>
                <Collapsible open={cancelledOpen} onOpenChange={setCancelledOpen}>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuSubButton asChild>
                      <button className="flex items-center gap-2 w-full text-muted-foreground opacity-50">
                        <Ban className="h-3 w-3 shrink-0" />
                        <span className="truncate">Cancelled ({cancelledTasks.length})</span>
                        <ChevronRight className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 data-[state=open]:rotate-90" data-state={cancelledOpen ? 'open' : 'closed'} />
                      </button>
                    </SidebarMenuSubButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {cancelledTasks.map((task) => (
                        <ScheduledTaskSubItem
                          key={task.id}
                          task={task}
                          agentSlug={agentSlug}
                        />
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </Collapsible>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
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
  const { selectedDashboardSlug, selectAgent, selectDashboard } = useSelection()
  const isSelected = artifact.slug === selectedDashboardSlug
  const [isRenaming, setIsRenaming] = useState(false)

  const handleClick = () => {
    selectAgent(agentSlug)
    selectDashboard(artifact.slug)
  }

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
          <button
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            className="flex items-center gap-2 w-full"
          >
            <LayoutDashboard className="h-3 w-3 shrink-0" />
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
          </button>
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

// Agent menu item with expandable sessions
export const AgentMenuItem = React.forwardRef<
  HTMLLIElement,
  { agent: ApiAgent } & React.HTMLAttributes<HTMLLIElement>
>(({ agent, style, ...rest }, ref) => {
  useRenderTracker('AgentMenuItem')
  const { selectedAgentSlug, selectAgent } = useSelection()
  const { agentMemberCount } = useUser()
  const queryClient = useQueryClient()
  const isSelected = agent.slug === selectedAgentSlug
  const [isOpen, setIsOpen] = useState(isSelected)
  const [showAll, setShowAll] = useState(false)
  const [showSkeleton, setShowSkeleton] = useState(false)
  const isShared = agentMemberCount(agent.slug) > 1

  // Lazy-load detail data only when expanded
  const { data: sessions, isLoading: sessionsLoading } = useSessions(isOpen ? agent.slug : null)
  const { data: scheduledTasks } = useScheduledTasks(isOpen ? agent.slug : null, 'pending')
  const { data: cancelledScheduledTasks } = useScheduledTasks(isOpen ? agent.slug : null, 'cancelled')
  const { data: artifacts } = useArtifacts(isOpen ? agent.slug : null)

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5
  const pendingTasks = scheduledTasks || []
  const cancelledTasks = cancelledScheduledTasks || []
  const allScheduledTasks = pendingTasks.length + cancelledTasks.length
  const dashboards = Array.isArray(artifacts) ? artifacts : []

  // Use pre-aggregated counts to determine if the chevron should show.
  // Also show when isOpen (agent selected) since sessions may have been
  // created after the agent list was fetched.
  const hasExpandableContent =
    isOpen ||
    (agent.sessionCount ?? 0) > 0 ||
    (agent.scheduledTaskCount ?? 0) > 0 ||
    (agent.dashboardCount ?? 0) > 0

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

  const handleClick = () => {
    selectAgent(agent.slug)
    setIsOpen((prev) => !prev)
  }

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
      <SidebarMenuItem ref={ref} style={style} {...rest} onMouseEnter={handleMouseEnter}>
        <AgentContextMenu agent={agent}>
          <SidebarMenuButton
            onClick={handleClick}
            isActive={isSelected}
            className="justify-between"
            data-testid={`agent-item-${agent.slug}`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="truncate">{agent.name}</span>
              {isShared && <Users className="h-3 w-3 shrink-0 text-muted-foreground" />}
            </span>
            <AgentStatus
              status={agent.status}
              hasActiveSessions={sessions ? sessions.some((s) => s.isActive) : (agent.hasActiveSessions ?? false)}
              hasSessionsAwaitingInput={sessions ? sessions.some((s) => s.isAwaitingInput) : (agent.hasSessionsAwaitingInput ?? false)}
            />
          </SidebarMenuButton>
        </AgentContextMenu>
        {hasExpandableContent ? (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction className="data-[state=open]:rotate-90">
                <ChevronRight />
                <span className="sr-only">Toggle sessions</span>
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {isOpen && sessionsLoading && showSkeleton ? (
                  <SessionsSkeleton />
                ) : (
                  <>
                    {/* Dashboards at the top */}
                    {dashboards.map((artifact) => (
                      <DashboardSubItem
                        key={artifact.slug}
                        artifact={artifact}
                        agentSlug={agent.slug}
                      />
                    ))}
                    {/* Scheduled tasks */}
                    {cancelledTasks.length > 0 || allScheduledTasks > 1 ? (
                      <ScheduledTasksGroup
                        pendingTasks={pendingTasks}
                        cancelledTasks={cancelledTasks}
                        agentSlug={agent.slug}
                      />
                    ) : pendingTasks.length === 1 ? (
                      <ScheduledTaskSubItem
                        task={pendingTasks[0]}
                        agentSlug={agent.slug}
                      />
                    ) : null}
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

function UserFooter() {
  const { isAuthMode, user, signOut } = useUser()

  if (!isAuthMode || !user) {
    return (
      <div className="px-2 text-xs text-muted-foreground">
        Version: {__APP_VERSION__}
      </div>
    )
  }

  return (
    <div className="px-2 flex items-center justify-between">
      <Popover>
        <PopoverTrigger asChild>
          <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="user-menu-trigger">
            <User className="h-3 w-3" />
            <span className="truncate max-w-[140px]">{user.name}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1">
          <button
            onClick={signOut}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-sm hover:bg-accent transition-colors"
            data-testid="sign-out-button"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">v{__APP_VERSION__}</span>
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
    <div className="px-2 pt-2">
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

export function AppSidebar() {
  useRenderTracker('AppSidebar')
  const { settingsOpen, setSettingsOpen, settingsTab, openSettings, createAgentOpen, setCreateAgentOpen, openWizard } = useDialogs()
  const { clearSelection } = useSelection()
  const [containerSetupOpen, setContainerSetupOpen] = useState(false)
  const { data: agents, isLoading, error } = useAgents()
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const { data: runtimeStatus } = useRuntimeStatus()
  const isFullScreen = useFullScreen()

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

  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeUnavailable = readiness?.status === 'RUNTIME_UNAVAILABLE' || readiness?.status === 'ERROR'
  const isPullingOrBuilding = readiness?.status === 'PULLING_IMAGE'
  const isChecking = readiness?.status === 'CHECKING'

  // Track if we've shown the initial container setup dialog
  const hasShownInitialSetup = useRef(false)

  // Automatically show the container setup dialog on first load if runtime is unavailable
  // Skip if setup wizard hasn't been completed yet — it already covers runtime setup
  useEffect(() => {
    if (isRuntimeUnavailable && !hasShownInitialSetup.current && userSettings?.setupCompleted) {
      hasShownInitialSetup.current = true
      setContainerSetupOpen(true)
    }
  }, [isRuntimeUnavailable, userSettings?.setupCompleted])

  useEffect(() => {
    const handleOpenGlobalSettings = (event: Event) => {
      const customEvent = event as CustomEvent<{ initialTab?: string }>
      openSettings(customEvent.detail?.initialTab)
    }

    window.addEventListener('open-global-settings', handleOpenGlobalSettings as EventListener)
    return () => {
      window.removeEventListener('open-global-settings', handleOpenGlobalSettings as EventListener)
    }
  }, [openSettings])

  // Add left padding for macOS traffic lights in Electron (not in full screen)
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !isFullScreen

  return (
    <Sidebar data-testid="app-sidebar">
      <SidebarHeader
        className="h-12 border-b app-drag-region"
        style={{
          paddingLeft: needsTrafficLightPadding ? '80px' : undefined,
        }}
      >
        <div className="flex items-center h-full px-2">
          <button onClick={clearSelection} className="text-lg font-bold app-no-drag cursor-pointer hover:opacity-80 transition-opacity">
            Super Agent
          </button>
        </div>
      </SidebarHeader>

      {!isOnline && (
        <div className="px-2 pt-2">
          <Alert variant="destructive" className="py-2 [&>svg]:top-2.5">
            <WifiOff className="h-4 w-4" />
            <AlertDescription className="text-xs">
              No internet connection. Some features may be unavailable.
            </AlertDescription>
          </Alert>
        </div>
      )}

      {isRuntimeUnavailable && (
        <div className="px-2 pt-2">
          <Alert
            variant="destructive"
            className="py-2 [&>svg]:top-2.5 cursor-pointer hover:bg-destructive/20 transition-colors"
            onClick={() => setSettingsOpen(true)}
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {readiness?.message || 'Container runtime not available.'}{' '}
              <span className="underline">Open settings</span>
            </AlertDescription>
          </Alert>
        </div>
      )}

      {isChecking && (
        <div className="px-2 pt-2">
          <Alert className="py-2 [&>svg]:top-2.5">
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertDescription className="text-xs">
              {readiness?.message || 'Starting runtime...'}
            </AlertDescription>
          </Alert>
        </div>
      )}

      {isPullingOrBuilding && (
        <div className="px-2 pt-2">
          <Alert className="py-2 [&>svg]:top-2.5">
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertDescription className="text-xs">
              {readiness?.message || 'Preparing agent image...'}
              {readiness?.pullProgress?.percent != null && (
                <span className="ml-1">({readiness.pullProgress.percent}%)</span>
              )}
            </AlertDescription>
          </Alert>
        </div>
      )}

      <ApiKeyWarning onOpenSettings={() => setSettingsOpen(true)} />

      <ErrorBoundary compact>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Agents</SidebarGroupLabel>
            <SidebarGroupAction onClick={() => setCreateAgentOpen(true)} title="New Agent" data-testid="create-agent-button">
              <Plus />
              <span className="sr-only">New Agent</span>
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {isLoading ? (
                  <>
                    {Array.from({ length: 3 }).map((_, index) => (
                      <SidebarMenuItem key={index}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}
                  </>
                ) : error ? (
                  <div className="px-2 py-4 text-sm text-destructive">
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

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center justify-between w-full">
              <SidebarMenuButton onClick={() => setSettingsOpen(true)} className="flex-1" data-testid="settings-button">
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </SidebarMenuButton>
              <NotificationBell />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
        <UserFooter />
      </SidebarFooter>

      <CreateAgentDialog
        open={createAgentOpen}
        onOpenChange={setCreateAgentOpen}
      />

      <GlobalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onOpenWizard={openWizard}
        initialTab={settingsTab}
      />

      <ContainerSetupDialog
        open={containerSetupOpen}
        onOpenChange={setContainerSetupOpen}
      />

      <SidebarRail />
    </Sidebar>
  )
}

if (__RENDER_TRACKING__) {
  (AppSidebar as any).whyDidYouRender = true
}
