
import { Bell, ChevronDown, ChevronRight, Plus, Search, Settings, AlertTriangle, LayoutGrid, Loader2, SquareMousePointer, WifiOff, LogOut, User, Users, Compass } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import React, { useState, useEffect, useMemo, useCallback } from 'react'
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
} from '@renderer/components/ui/sidebar'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSessions, type ApiSession } from '@renderer/hooks/use-sessions'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { useCreateUntitledAgent } from '@renderer/hooks/use-create-untitled-agent'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { WorkingDots, AwaitingDot } from '@renderer/components/agents/status-indicators'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { DashboardContextMenu } from '@renderer/components/dashboards/dashboard-context-menu'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useSelection } from '@renderer/context/selection-context'
import { useSearch } from '@renderer/context/search-context'
import { useArtifacts, type ArtifactInfo } from '@renderer/hooks/use-artifacts'
import { useChatIntegrations, useChatIntegrationSessions, type ChatIntegration } from '@renderer/hooks/use-chat-integrations'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useUser } from '@renderer/context/user-context'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { useUnreadNotificationCount } from '@renderer/hooks/use-notifications'
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
import { useDiscoverableAgents } from '@renderer/hooks/use-agent-templates'
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
  const { view, setAgent } = useSelection()
  const isSelected = view.kind === 'session' && view.id === session.id
  const { isStreaming } = useMessageStream(isSelected ? session.id : null, isSelected ? agentSlug : null)
  const isWorking = (session.isActive || isStreaming) && !session.isAwaitingInput
  const isAwaitingInput = session.isAwaitingInput
  const hasUnread = !session.isActive && !session.isAwaitingInput && session.hasUnreadNotifications

  const handleClick = () => {
    setAgent(agentSlug, { kind: 'session', id: session.id })
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
          <button
            onClick={handleClick}
            className="flex items-center gap-2 w-full"
            data-testid={`session-item-${session.id}`}
          >
            <span className="flex-1 min-w-0 truncate text-left">{session.name}</span>
            <span className="flex items-center justify-center w-4 shrink-0">
              {isAwaitingInput ? (
                <AwaitingDot />
              ) : isWorking ? (
                <WorkingDots />
              ) : hasUnread ? (
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" role="img" aria-label="unread notifications" />
              ) : null}
            </span>
          </button>
        </SidebarMenuSubButton>
      </SessionContextMenu>
    </SidebarMenuSubItem>
  )
}

// Chat integration sub-item (with expandable chat sessions)
function ChatIntegrationSubItem({
  integration,
  agentSlug,
}: {
  integration: ChatIntegration
  agentSlug: string
}) {
  const { view, setAgent } = useSelection()
  const { data: sessions } = useChatIntegrationSessions(integration.id)
  const viewingThisIntegration = view.kind === 'chat' && view.integrationId === integration.id
  const selectedChatSessionId = view.kind === 'chat' ? view.sessionId ?? null : null
  const isSelected = viewingThisIntegration && !selectedChatSessionId
  const hasSelectedSession = viewingThisIntegration && selectedChatSessionId != null
  const [isOpen, setIsOpen] = useState(viewingThisIntegration || hasSelectedSession)

  const handleClick = () => {
    setAgent(agentSlug, { kind: 'chat', integrationId: integration.id })
  }

  const handleSessionClick = (sessionId: string) => {
    setAgent(agentSlug, { kind: 'chat', integrationId: integration.id, sessionId })
  }

  const statusDot = integration.status === 'active' ? 'bg-green-500' :
    integration.status === 'paused' ? 'bg-yellow-500' :
    integration.status === 'error' ? 'bg-red-500' : 'bg-gray-400'

  const tooltip = `${integration.provider}: ${integration.status}`
  const hasSessions = sessions && sessions.length > 0

  return (
    <SidebarMenuSubItem>
      {hasSessions ? (
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <div className="flex items-center">
            <SidebarMenuSubButton
              asChild
              isActive={isSelected}
              title={tooltip}
              className="flex-1"
            >
              <button
                onClick={handleClick}
                className={`flex items-center gap-2 w-full text-muted-foreground ${integration.status === 'paused' ? 'opacity-50' : 'opacity-70'}`}
              >
                <span className="truncate">
                  {integration.name || formatProviderName(integration.provider)}
                </span>
                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot}`} />
                <CollapsibleTrigger asChild>
                  <button
                    onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen) }}
                    className="ml-auto p-0.5"
                  >
                    <ChevronRight className="h-3 w-3 shrink-0 transition-transform duration-200" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }} />
                  </button>
                </CollapsibleTrigger>
              </button>
            </SidebarMenuSubButton>
          </div>
          <CollapsibleContent>
            <SidebarMenuSub>
              {sessions.map((session) => {
                const isArchived = session.archivedAt != null
                return (
                  <SidebarMenuSubItem key={session.id}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={selectedChatSessionId === session.sessionId}
                    >
                      <button
                        onClick={() => handleSessionClick(session.sessionId)}
                        className={`flex items-center gap-2 w-full text-muted-foreground ${isArchived ? 'opacity-40' : 'opacity-70'}`}
                      >
                        <span className="truncate text-xs">
                          {session.displayName || `Chat ${session.externalChatId.slice(-6)}`}
                        </span>
                        {isArchived && (
                          <span className="ml-auto text-2xs text-muted-foreground/50 shrink-0">archived</span>
                        )}
                      </button>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <SidebarMenuSubButton
          asChild
          isActive={isSelected}
          title={tooltip}
        >
          <button
            onClick={handleClick}
            className={`flex items-center gap-2 w-full text-muted-foreground ${integration.status === 'paused' ? 'opacity-50' : 'opacity-70'}`}
          >
            <span className="truncate">
              {integration.name || formatProviderName(integration.provider)}
            </span>
            <span className={`ml-auto h-1.5 w-1.5 rounded-full shrink-0 ${statusDot}`} />
          </button>
        </SidebarMenuSubButton>
      )}
    </SidebarMenuSubItem>
  )
}

// Collapsible group for multiple chat integrations
function ChatIntegrationsGroup({
  integrations,
  agentSlug,
}: {
  integrations: ChatIntegration[]
  agentSlug: string
}) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <SidebarMenuSubItem>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton asChild>
            <button className="flex items-center gap-2 w-full text-muted-foreground opacity-70">
              <span className="truncate">Chat Integrations ({integrations.length})</span>
              <ChevronRight className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 data-[state=open]:rotate-90" data-state={isOpen ? 'open' : 'closed'} />
            </button>
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {integrations.map((integration) => (
              <ChatIntegrationSubItem
                key={integration.id}
                integration={integration}
                agentSlug={agentSlug}
              />
            ))}
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
  const { view, setAgent } = useSelection()
  const isSelected = view.kind === 'dashboard' && view.slug === artifact.slug
  const [isRenaming, setIsRenaming] = useState(false)

  const handleClick = () => {
    setAgent(agentSlug, { kind: 'dashboard', slug: artifact.slug })
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

// Right-side indicator on the agent row.
// When expanded, suppress session-derived states (awaiting / working / unread)
// since the individual session rows already surface those. Keep agent-level
// sleeping / idle states which describe the container itself.
// Priority when collapsed: awaiting > working > unread > sleeping/idle.
function AgentRowIndicator({
  agent,
  sessions,
  isOpen,
}: {
  agent: ApiAgent
  sessions: ApiSession[] | undefined
  isOpen: boolean
}) {
  const isAwaiting = !isOpen && (sessions?.some((s) => s.isAwaitingInput) || (agent.hasSessionsAwaitingInput ?? false))
  const isWorking = !isOpen && !isAwaiting && (sessions?.some((s) => s.isActive) || (agent.hasActiveSessions ?? false))
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
  const { selectedAgentSlug, setAgent, view } = useSelection()
  const { agentMemberCount } = useUser()
  const queryClient = useQueryClient()
  const isSelected = agent.slug === selectedAgentSlug
  // Auto-expand on selection only if the agent has content to show. Brand-new
  // agents (no sessions / dashboards / chat integrations yet) start collapsed
  // — the empty submenu would just be visual noise.
  const hasInitialContent =
    (agent.sessionCount ?? 0) > 0 ||
    (agent.chatIntegrationCount ?? 0) > 0 ||
    (agent.dashboardCount ?? 0) > 0
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
  const { data: chatIntegrationsData } = useChatIntegrations(isOpen ? agent.slug : null, 'active')

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5
  const dashboards = Array.isArray(artifacts) ? artifacts : []
  const chatIntegrations = chatIntegrationsData || []

  // Use pre-aggregated counts to determine if the chevron should show.
  // Also show when isOpen (agent selected) since sessions may have been
  // created after the agent list was fetched.
  const hasExpandableContent =
    isOpen ||
    (agent.sessionCount ?? 0) > 0 ||
    (agent.chatIntegrationCount ?? 0) > 0 ||
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
    setAgent(agent.slug)
  }

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsOpen((prev) => !prev)
  }

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
              onClick={handleClick}
              isActive={isSelected}
              className="justify-between pl-7"
              data-testid={`agent-item-${agent.slug}`}
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-[13px] font-normal text-sidebar-foreground">{agent.name}</span>
                {isShared && <Users className="h-3 w-3 shrink-0 text-muted-foreground" />}
              </span>
              <AgentRowIndicator agent={agent} sessions={sessions} isOpen={isOpen} />
            </SidebarMenuButton>
          </AgentContextMenu>
          {/*
            Sibling chevron button overlays its slot in the row so the row stays a
            single <button> (no nested interactive controls).
          */}
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
        </div>
        {hasExpandableContent ? (
          <>
            <CollapsibleContent>
              <SidebarMenuSub className="pb-2">
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
                    {/* Chat integrations */}
                    {chatIntegrations.length > 1 ? (
                      <ChatIntegrationsGroup
                        integrations={chatIntegrations}
                        agentSlug={agent.slug}
                      />
                    ) : chatIntegrations.length === 1 ? (
                      <ChatIntegrationSubItem
                        integration={chatIntegrations[0]}
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

function NotificationsMenuButton() {
  const { data: countData } = useUnreadNotificationCount()
  const unreadCount = countData?.count ?? 0
  const { view, setView } = useSelection()
  const isActive = view.kind === 'notifications'

  return (
    <SidebarMenuButton
      data-testid="notifications-button"
      isActive={isActive}
      onClick={() => setView({ kind: 'notifications' })}
    >
      <Bell className="h-4 w-4" />
      <span>Notifications</span>
      {unreadCount > 0 && (
        <span
          className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-500"
          aria-label={`${unreadCount} unread`}
        />
      )}
    </SidebarMenuButton>
  )
}

function UserMenu() {
  const { isAuthMode, user, signOut } = useUser()
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

export function AppSidebar() {
  useRenderTracker('AppSidebar')
  const { setSettingsOpen, openSettings } = useDialogs()
  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()
  const updateStatus = useUpdateStatus()
  const updateAvailable = updateStatus.state === 'available' || updateStatus.state === 'downloaded'

  // Electron menu → New Agent
  useEffect(() => {
    if (!window.electronAPI?.onOpenCreateAgent) return
    window.electronAPI.onOpenCreateAgent(() => { void createUntitledAgent() })
    return () => {
      window.electronAPI?.removeOpenCreateAgent?.()
    }
  }, [createUntitledAgent])
  const { clearSelection, selectedAgentSlug } = useSelection()
  const { openSearch } = useSearch()
  const { data: agents, isLoading, error } = useAgents()
  const { data: discoverableAgents } = useDiscoverableAgents()
  const hasMarketplace = !!(discoverableAgents && discoverableAgents.length > 0)
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

  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeUnavailable = readiness?.status === 'RUNTIME_UNAVAILABLE' || readiness?.status === 'ERROR'
  const isPullingOrBuilding = readiness?.status === 'PULLING_IMAGE'
  const isChecking = readiness?.status === 'CHECKING'

  // The header bar exists only to leave room for macOS traffic lights when
  // windowed. In every other case (mac fullscreen, windows, web) it collapses
  // to 0 height so the wordmark sits flush with the top of the sidebar.
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !animatedFullScreen
  const isWindowsElectron = isElectron() && getPlatform() === 'win32'
  const showHeaderBar = needsTrafficLightPadding

  return (
    <>
      <Sidebar variant="inset" data-testid="app-sidebar">
      {/*
        Always rendered so height/border can transition smoothly when entering
        or leaving fullscreen on macOS. Collapses to 0 height (with no border)
        when there's no traffic-light spacer to make room for and no Windows
        menu chevron to host.
      */}
      <SidebarHeader
        className={cn(
          'app-drag-region p-0 overflow-hidden transition-[height,border-bottom-width] duration-200 ease-out',
          showHeaderBar ? 'h-12 border-b' : 'h-0 border-b-0'
        )}
        style={{
          paddingLeft: needsTrafficLightPadding ? '80px' : undefined,
        }}
      >
        <div className="flex items-center h-12 px-2 gap-1" />
      </SidebarHeader>

      <ErrorBoundary compact>
        <SidebarContent className="overflow-visible">
          <SidebarGroup className="shrink-0 p-0">
            {/*
              When the header bar is present its 48px sit above the wordmark
              (small `-4px` pull-up tightens the gap). When it's collapsed the
              wordmark needs its own breathing room. Animated via marginTop so
              the transition matches the header collapse on fullscreen toggle.
            */}
            <div
              className={cn(
                'px-2 pb-2 text-base font-semibold select-none transition-[margin-top] duration-200 ease-out flex items-center gap-1',
                isWindowsElectron && 'app-drag-region'
              )}
              style={{ marginTop: showHeaderBar ? '-8px' : '8px' }}
            >
              <span>SuperAgent</span>
              {isWindowsElectron && (
                <button
                  className="app-no-drag p-0.5 rounded hover:bg-foreground/10 transition-colors cursor-default"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    window.electronAPI?.popupAppMenu(Math.round(rect.left), Math.round(rect.bottom))
                  }}
                >
                  <ChevronDown className="h-4 w-4 text-foreground/60" />
                </button>
              )}
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={openSearch}
                      aria-label="Search"
                      className="app-no-drag ml-auto -mr-2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 transition-colors"
                      data-testid="search-button"
                    >
                      <Search className="h-4 w-4 -translate-y-[1px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="flex items-center gap-2">
                    <span>Search</span>
                    <span className="opacity-70">{getPlatform() === 'darwin' ? '⌘K' : 'Ctrl+K'}</span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            {/* Status banners — render under the wordmark so they sit inside the
                sidebar's content area rather than pushing the wordmark down. */}
            {!isOnline && (
              <div className="px-2 pb-2">
                <Alert variant="destructive" className="py-2 [&>svg]:top-2.5">
                  <WifiOff className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No internet connection. Some features may be unavailable.
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {isRuntimeUnavailable && (
              <div className="px-2 pb-2">
                <Alert
                  variant="destructive"
                  className="py-2 [&>svg]:top-2.5 cursor-pointer hover:bg-destructive/20 transition-colors"
                  onClick={() => openSettings('runtime')}
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
              <div className="px-2 pb-2">
                <Alert className="py-2 [&>svg]:top-2.5">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <AlertDescription className="text-xs">
                    {readiness?.message || 'Starting runtime...'}
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {isPullingOrBuilding && (
              <div className="px-2 pb-2">
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

            <ApiKeyWarning onOpenSettings={() => openSettings('llm')} />
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5 py-2">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={clearSelection}
                    isActive={!selectedAgentSlug}
                    data-testid="home-button"
                  >
                    <LayoutGrid className="h-4 w-4" />
                    <span>Home</span>
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

      <SidebarFooter className="border-t p-0 px-2 pt-1">
        <UserMenu />
        <div className="flex items-center justify-between gap-2">
          <SidebarMenuButton
            onClick={() => setSettingsOpen(true)}
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
