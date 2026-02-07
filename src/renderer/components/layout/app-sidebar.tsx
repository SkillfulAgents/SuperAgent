
import { ChevronRight, Plus, Settings, AlertTriangle, Clock, LayoutDashboard, Loader2 } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { isElectron, getPlatform } from '@renderer/lib/env'
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
} from '@renderer/components/ui/sidebar'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSessions, type ApiSession } from '@renderer/hooks/use-sessions'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSettings } from '@renderer/hooks/use-settings'
import { CreateAgentDialog } from '@renderer/components/agents/create-agent-dialog'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { useSelection } from '@renderer/context/selection-context'
import { useScheduledTasks, type ApiScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { useArtifacts, type ArtifactInfo } from '@renderer/hooks/use-artifacts'
import { GlobalSettingsDialog } from '@renderer/components/settings/global-settings-dialog'
import { ContainerSetupDialog } from '@renderer/components/settings/container-setup-dialog'
import { NotificationBell } from '@renderer/components/notifications/notification-bell'

// Session sub-item that tracks its streaming state
function SessionSubItem({
  session,
  agentSlug,
}: {
  session: ApiSession
  agentSlug: string
}) {
  const { selectedSessionId, selectAgent, selectSession } = useSelection()
  const isSelected = session.id === selectedSessionId
  const { isStreaming } = useMessageStream(isSelected ? session.id : null, isSelected ? agentSlug : null)
  const showActive = session.isActive || isStreaming

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
            {showActive && (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-current"></span>
              </span>
            )}
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

  // Format next execution time for tooltip
  const nextExecution = new Date(task.nextExecutionAt)
  const timeString = nextExecution.toLocaleString()

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isSelected}
        title={`Scheduled for: ${timeString}`}
      >
        <button
          onClick={handleClick}
          className="flex items-center gap-2 w-full text-muted-foreground opacity-70"
        >
          <Clock className="h-3 w-3 shrink-0" />
          <span className="truncate">{task.name || 'Scheduled Task'}</span>
        </button>
      </SidebarMenuSubButton>
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

  const handleClick = () => {
    selectAgent(agentSlug)
    selectDashboard(artifact.slug)
  }

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isSelected}
        title={artifact.description || artifact.name}
      >
        <button
          onClick={handleClick}
          className="flex items-center gap-2 w-full"
        >
          <LayoutDashboard className="h-3 w-3 shrink-0" />
          <span className="truncate">{artifact.name}</span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

// Agent menu item with expandable sessions
function AgentMenuItem({ agent }: { agent: ApiAgent }) {
  const { selectedAgentSlug, selectAgent } = useSelection()
  const { data: sessions } = useSessions(agent.slug)
  const { data: scheduledTasks } = useScheduledTasks(agent.slug, 'pending')
  const { data: artifacts } = useArtifacts(agent.slug)
  const isSelected = agent.slug === selectedAgentSlug
  const [isOpen, setIsOpen] = useState(isSelected)
  const [showAll, setShowAll] = useState(false)

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5
  const pendingTasks = scheduledTasks || []
  const dashboards = artifacts || []

  const handleClick = () => {
    selectAgent(agent.slug)
    setIsOpen((prev) => !prev)
  }

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
      <SidebarMenuItem>
        <AgentContextMenu agent={agent}>
          <SidebarMenuButton
            onClick={handleClick}
            isActive={isSelected}
            className="justify-between"
            data-testid={`agent-item-${agent.slug}`}
          >
            <span className="truncate">{agent.name}</span>
            <AgentStatus
              status={agent.status}
              hasActiveSessions={sessions?.some((s) => s.isActive) ?? false}
            />
          </SidebarMenuButton>
        </AgentContextMenu>
        {(sessions?.length || pendingTasks.length || dashboards.length) ? (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction className="data-[state=open]:rotate-90">
                <ChevronRight />
                <span className="sr-only">Toggle sessions</span>
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {/* Dashboards at the top */}
                {dashboards.map((artifact) => (
                  <DashboardSubItem
                    key={artifact.slug}
                    artifact={artifact}
                    agentSlug={agent.slug}
                  />
                ))}
                {/* Pending scheduled tasks */}
                {pendingTasks.map((task) => (
                  <ScheduledTaskSubItem
                    key={task.id}
                    task={task}
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
              </SidebarMenuSub>
            </CollapsibleContent>
          </>
        ) : null}
      </SidebarMenuItem>
    </Collapsible>
  )
}

export function AppSidebar() {
  const { settingsOpen, setSettingsOpen, createAgentOpen, setCreateAgentOpen, openWizard } = useDialogs()
  const [containerSetupOpen, setContainerSetupOpen] = useState(false)
  const { data: agents, isLoading, error } = useAgents()
  const { data: settings } = useSettings()
  const isFullScreen = useFullScreen()

  const readiness = settings?.runtimeReadiness
  const isRuntimeUnavailable = readiness?.status === 'RUNTIME_UNAVAILABLE' || readiness?.status === 'ERROR'
  const isPullingOrBuilding = readiness?.status === 'PULLING_IMAGE'

  // Track if we've shown the initial container setup dialog
  const hasShownInitialSetup = useRef(false)

  // Automatically show the container setup dialog on first load if runtime is unavailable
  useEffect(() => {
    if (isRuntimeUnavailable && !hasShownInitialSetup.current) {
      hasShownInitialSetup.current = true
      setContainerSetupOpen(true)
    }
  }, [isRuntimeUnavailable])

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
          <span className="text-lg font-bold">Super Agent</span>
        </div>
      </SidebarHeader>

      {isRuntimeUnavailable && (
        <div className="px-2 pt-2">
          <Alert
            variant="destructive"
            className="py-2 cursor-pointer hover:bg-destructive/20 transition-colors"
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

      {isPullingOrBuilding && (
        <div className="px-2 pt-2">
          <Alert className="py-2">
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

      {settings?.apiKeyStatus?.anthropic && !settings.apiKeyStatus.anthropic.isConfigured && (
        <div className="px-2 pt-2">
          <Alert
            variant="destructive"
            className="py-2 cursor-pointer hover:bg-destructive/20 transition-colors"
            onClick={() => setSettingsOpen(true)}
          >
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              No API key configured.{' '}
              <span className="underline">Click to set up</span>
            </AlertDescription>
          </Alert>
        </div>
      )}

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
                agents.map((agent) => (
                  <AgentMenuItem key={agent.slug} agent={agent} />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center justify-between w-full">
              <SidebarMenuButton onClick={() => setSettingsOpen(true)} className="flex-1">
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </SidebarMenuButton>
              <NotificationBell />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-2 text-xs text-muted-foreground">
          Version: {__APP_VERSION__}
        </div>
      </SidebarFooter>

      <CreateAgentDialog
        open={createAgentOpen}
        onOpenChange={setCreateAgentOpen}
      />

      <GlobalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onOpenWizard={openWizard}
      />

      <ContainerSetupDialog
        open={containerSetupOpen}
        onOpenChange={setContainerSetupOpen}
      />
    </Sidebar>
  )
}
