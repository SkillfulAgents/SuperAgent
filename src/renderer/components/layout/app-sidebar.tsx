
import { Bell, ChevronDown, ChevronRight, Plus, Settings, AlertTriangle, LayoutGrid, Loader2, SquareMousePointer, WifiOff, LogOut, User, Users } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
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
import { useWebhookTriggers } from '@renderer/hooks/use-webhook-triggers'
import { useArtifacts, type ArtifactInfo } from '@renderer/hooks/use-artifacts'
import { useChatIntegrations, useChatIntegrationSessions, type ChatIntegration } from '@renderer/hooks/use-chat-integrations'
import { formatProviderName } from '@shared/lib/chat-integrations/utils'
import { GlobalSettingsDialog } from '@renderer/components/settings/global-settings-dialog'
import { ContainerSetupDialog } from '@renderer/components/settings/container-setup-dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useUser } from '@renderer/context/user-context'
import { NotificationsPopoverContent } from '@renderer/components/notifications/notification-bell'
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
          <button
            onClick={handleClick}
            className="flex items-center gap-2 w-full"
            data-testid={`session-item-${session.id}`}
          >
            <span className="flex-1 min-w-0 truncate text-left">{session.name}</span>
            <span className="flex items-center justify-center w-4 shrink-0">
              {isAwaitingInput ? (
                <AwaitingDot size="sm" />
              ) : isWorking ? (
                <WorkingDots />
              ) : hasUnread ? (
                <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
              ) : null}
            </span>
          </button>
        </SidebarMenuSubButton>
      </SessionContextMenu>
    </SidebarMenuSubItem>
  )
}

// Webhook trigger sub-item
function WebhookTriggerSubItem({
  trigger,
  agentSlug,
}: {
  trigger: { id: string; name: string | null; triggerType: string; status: string }
  agentSlug: string
}) {
  const { selectedWebhookTriggerId, selectAgent, selectWebhookTrigger } = useSelection()
  const isSelected = trigger.id === selectedWebhookTriggerId

  const handleClick = () => {
    selectAgent(agentSlug)
    selectWebhookTrigger(trigger.id)
  }

  const tooltip = trigger.status === 'cancelled'
    ? `Cancelled trigger: ${trigger.triggerType}`
    : trigger.status === 'paused'
    ? `Paused trigger: ${trigger.triggerType}`
    : `Trigger: ${trigger.triggerType}`

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isSelected}
        title={tooltip}
      >
        <button
          onClick={handleClick}
          className={`flex items-center gap-2 w-full text-muted-foreground ${trigger.status === 'cancelled' ? 'opacity-50' : 'opacity-70'}`}
        >
          <span className="truncate">{trigger.name || trigger.triggerType}</span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

// Collapsible group for multiple webhook triggers
function WebhookTriggersGroup({
  activeTriggers,
  cancelledTriggers,
  agentSlug,
}: {
  activeTriggers: Array<{ id: string; name: string | null; triggerType: string; status: string }>
  cancelledTriggers: Array<{ id: string; name: string | null; triggerType: string; status: string }>
  agentSlug: string
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [cancelledOpen, setCancelledOpen] = useState(false)
  const totalCount = activeTriggers.length + cancelledTriggers.length

  return (
    <SidebarMenuSubItem>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <SidebarMenuSubButton asChild>
            <button className="flex items-center gap-2 w-full text-muted-foreground opacity-70">
              <span className="truncate">Webhook Triggers ({totalCount})</span>
              <ChevronRight className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 data-[state=open]:rotate-90" data-state={isOpen ? 'open' : 'closed'} />
            </button>
          </SidebarMenuSubButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {activeTriggers.map((trigger) => (
              <WebhookTriggerSubItem
                key={trigger.id}
                trigger={trigger}
                agentSlug={agentSlug}
              />
            ))}
            {cancelledTriggers.length > 0 && (
              <SidebarMenuSubItem>
                <Collapsible open={cancelledOpen} onOpenChange={setCancelledOpen}>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuSubButton asChild>
                      <button className="flex items-center gap-2 w-full text-muted-foreground opacity-50">
                        <span className="truncate">Cancelled ({cancelledTriggers.length})</span>
                        <ChevronRight className="ml-auto h-3 w-3 shrink-0 transition-transform duration-200 data-[state=open]:rotate-90" data-state={cancelledOpen ? 'open' : 'closed'} />
                      </button>
                    </SidebarMenuSubButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {cancelledTriggers.map((trigger) => (
                        <WebhookTriggerSubItem
                          key={trigger.id}
                          trigger={trigger}
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

// Chat integration sub-item (with expandable chat sessions)
function ChatIntegrationSubItem({
  integration,
  agentSlug,
}: {
  integration: ChatIntegration
  agentSlug: string
}) {
  const { selectedChatIntegrationId, selectedChatSessionId, selectAgent, selectChatIntegration, selectChatSession } = useSelection()
  const { data: sessions } = useChatIntegrationSessions(integration.id)
  const isSelected = integration.id === selectedChatIntegrationId && !selectedChatSessionId
  const hasSelectedSession = selectedChatIntegrationId === integration.id && selectedChatSessionId != null
  const [isOpen, setIsOpen] = useState(selectedChatIntegrationId === integration.id || hasSelectedSession)

  const handleClick = () => {
    selectAgent(agentSlug)
    selectChatIntegration(integration.id)
  }

  const handleSessionClick = (sessionId: string) => {
    selectAgent(agentSlug)
    selectChatSession(integration.id, sessionId)
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
  const { data: webhookTriggersData } = useWebhookTriggers(isOpen ? agent.slug : null, 'active')
  const { data: cancelledWebhookTriggersData } = useWebhookTriggers(isOpen ? agent.slug : null, 'cancelled')
  const { data: artifacts } = useArtifacts(isOpen ? agent.slug : null)
  const { data: chatIntegrationsData } = useChatIntegrations(isOpen ? agent.slug : null, 'active')

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5
  const activeWebhookTriggers = webhookTriggersData || []
  const cancelledWebhookTriggers = cancelledWebhookTriggersData || []
  const allWebhookTriggers = activeWebhookTriggers.length + cancelledWebhookTriggers.length
  const dashboards = Array.isArray(artifacts) ? artifacts : []
  const chatIntegrations = chatIntegrationsData || []

  // Use pre-aggregated counts to determine if the chevron should show.
  // Also show when isOpen (agent selected) since sessions may have been
  // created after the agent list was fetched.
  const hasExpandableContent =
    isOpen ||
    (agent.sessionCount ?? 0) > 0 ||
    (agent.chatIntegrationCount ?? 0) > 0 ||
    (agent.dashboardCount ?? 0) > 0 ||
    activeWebhookTriggers.length > 0

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
  }

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation()
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
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
              <span
                role="button"
                tabIndex={0}
                onClick={handleChevronClick}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    setIsOpen((prev) => !prev)
                  }
                }}
                aria-label={isOpen ? 'Collapse' : 'Expand'}
                aria-expanded={isOpen}
                className="-ml-0.5 p-0.5 rounded shrink-0 hover:bg-sidebar-accent cursor-pointer"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground/60 transition-[color,transform] group-hover/menu-item:text-sidebar-foreground',
                    isOpen && 'rotate-90'
                  )}
                />
              </span>
              <span className="truncate text-[13px] font-normal text-sidebar-foreground">{agent.name}</span>
              {isShared && <Users className="h-3 w-3 shrink-0 text-muted-foreground" />}
            </span>
            {(() => {
              // When expanded, suppress all session-derived states (awaiting / working / unread);
              // the individual session rows already show those. Keep agent-level
              // sleeping / idle states which describe the container itself.
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
            })()}
          </SidebarMenuButton>
        </AgentContextMenu>
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
                    {/* Webhook triggers */}
                    {cancelledWebhookTriggers.length > 0 || allWebhookTriggers > 1 ? (
                      <WebhookTriggersGroup
                        activeTriggers={activeWebhookTriggers}
                        cancelledTriggers={cancelledWebhookTriggers}
                        agentSlug={agent.slug}
                      />
                    ) : activeWebhookTriggers.length === 1 ? (
                      <WebhookTriggerSubItem
                        trigger={activeWebhookTriggers[0]}
                        agentSlug={agent.slug}
                      />
                    ) : null}
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

  return (
    <Popover>
      <PopoverTrigger asChild>
        <SidebarMenuButton data-testid="notifications-button">
          <Bell className="h-4 w-4" />
          <span>Notifications</span>
          {unreadCount > 0 && (
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-500" aria-label={`${unreadCount} unread`} />
          )}
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="start"
        side="right"
        sideOffset={8}
      >
        <NotificationsPopoverContent />
      </PopoverContent>
    </Popover>
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
  const { settingsOpen, setSettingsOpen, settingsTab, openWizard } = useDialogs()
  const { createUntitledAgent, isPending: isCreatingAgent } = useCreateUntitledAgent()

  // Electron menu → New Agent
  useEffect(() => {
    if (!window.electronAPI?.onOpenCreateAgent) return
    window.electronAPI.onOpenCreateAgent(() => { void createUntitledAgent() })
    return () => {
      window.electronAPI?.removeOpenCreateAgent?.()
    }
  }, [createUntitledAgent])
  const { clearSelection, selectedAgentSlug } = useSelection()
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

  // Add left padding for macOS traffic lights in Electron (not in full screen)
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !isFullScreen

  return (
    <Sidebar variant="inset" data-testid="app-sidebar">
      <SidebarHeader
        className="h-12 border-b app-drag-region"
        style={{
          paddingLeft: needsTrafficLightPadding ? '80px' : undefined,
        }}
      >
        <div className="flex items-center h-full px-2 gap-1">
          {isElectron() && getPlatform() === 'win32' && (
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
        <SidebarContent className="overflow-visible">
          <SidebarGroup className="shrink-0">
            <div className="-mt-1 px-2 pb-4 text-base font-semibold select-none">SuperAgent</div>
            <SidebarGroupContent>
              <SidebarMenu>
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
          <SidebarGroup className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--muted-foreground)/0.2)_transparent] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20">
            <SidebarGroupLabel className="mt-2 font-normal text-sidebar-foreground/50">Your Agents</SidebarGroupLabel>
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

      <SidebarFooter className="border-t pt-4">
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
          <span className="px-2 text-xs text-muted-foreground shrink-0">v{__APP_VERSION__}</span>
        </div>
      </SidebarFooter>

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
