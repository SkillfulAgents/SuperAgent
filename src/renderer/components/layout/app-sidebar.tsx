
import { ChevronRight, Plus, Settings, AlertTriangle } from 'lucide-react'
import { useState, useMemo } from 'react'
import { isElectron, getPlatform } from '@renderer/lib/env'
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
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { useSelection } from '@renderer/context/selection-context'
import { GlobalSettingsDialog } from '@renderer/components/settings/global-settings-dialog'

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
          <button onClick={handleClick} className="flex items-center gap-2 w-full">
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

// Agent menu item with expandable sessions
function AgentMenuItem({ agent }: { agent: ApiAgent }) {
  const { selectedAgentSlug, selectAgent } = useSelection()
  const { data: sessions } = useSessions(agent.slug)
  const isSelected = agent.slug === selectedAgentSlug
  const [isOpen, setIsOpen] = useState(isSelected)
  const [showAll, setShowAll] = useState(false)

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5

  const handleClick = () => {
    selectAgent(agent.slug)
    setIsOpen((prev) => !prev)
  }

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={handleClick}
          isActive={isSelected}
          className="justify-between"
        >
          <span className="truncate">{agent.name}</span>
          <AgentStatus
            status={agent.status}
            hasActiveSessions={sessions?.some((s) => s.isActive) ?? false}
          />
        </SidebarMenuButton>
        {sessions?.length ? (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuAction className="data-[state=open]:rotate-90">
                <ChevronRight />
                <span className="sr-only">Toggle sessions</span>
              </SidebarMenuAction>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
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
                          {showAll ? 'Show less' : `Show all (${sessions.length})`}
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
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const { data: agents, isLoading, error } = useAgents()
  const { data: settings } = useSettings()
  const isFullScreen = useFullScreen()

  const noRunnersAvailable = useMemo(() => {
    if (!settings?.runnerAvailability) return false
    return settings.runnerAvailability.every((r) => !r.available)
  }, [settings?.runnerAvailability])

  // Add left padding for macOS traffic lights in Electron (not in full screen)
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && !isFullScreen

  return (
    <Sidebar>
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

      {noRunnersAvailable && (
        <div className="px-2 pt-2">
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              No container runtime found. Install Docker or Podman.
            </AlertDescription>
          </Alert>
        </div>
      )}

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupAction onClick={() => setCreateDialogOpen(true)} title="New Agent">
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
            <SidebarMenuButton onClick={() => setSettingsDialogOpen(true)}>
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-2 text-xs text-muted-foreground">
          Version: {import.meta.env.VITE_VERSION || '0.1.0'}
        </div>
      </SidebarFooter>

      <CreateAgentDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      <GlobalSettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
      />
    </Sidebar>
  )
}
