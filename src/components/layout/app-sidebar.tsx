'use client'

import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
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
} from '@/components/ui/sidebar'
import { useAgents, type AgentWithStatus } from '@/lib/hooks/use-agents'
import { useSessions } from '@/lib/hooks/use-sessions'
import { useMessageStream } from '@/lib/hooks/use-message-stream'
import { CreateAgentDialog } from '@/components/agents/create-agent-dialog'
import { AgentStatus } from '@/components/agents/agent-status'

interface AppSidebarProps {
  selectedAgentId: string | null
  selectedSessionId: string | null
  onSelectAgent: (agentId: string) => void
  onSelectSession: (sessionId: string) => void
}

// Session sub-item that tracks its streaming state
function SessionSubItem({
  session,
  isSelected,
  onClick,
}: {
  session: { id: string; name: string; isActive: boolean }
  isSelected: boolean
  onClick: () => void
}) {
  const { isStreaming } = useMessageStream(isSelected ? session.id : null)
  const showActive = session.isActive || isStreaming

  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isSelected}
      >
        <button onClick={onClick} className="flex items-center gap-2 w-full">
          {showActive && (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-current"></span>
            </span>
          )}
          <span className="truncate">{session.name}</span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}

// Agent menu item with expandable sessions
function AgentMenuItem({
  agent,
  isSelected,
  selectedSessionId,
  onSelectAgent,
  onSelectSession,
}: {
  agent: AgentWithStatus
  isSelected: boolean
  selectedSessionId: string | null
  onSelectAgent: (agentId: string) => void
  onSelectSession: (sessionId: string) => void
}) {
  const { data: sessions } = useSessions(agent.id)
  const [isOpen, setIsOpen] = useState(isSelected)
  const [showAll, setShowAll] = useState(false)

  const visibleSessions = showAll ? sessions : sessions?.slice(0, 5)
  const hasMore = (sessions?.length ?? 0) > 5

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen}>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => {
            onSelectAgent(agent.id)
            setIsOpen((prev) => !prev)
          }}
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
                    isSelected={session.id === selectedSessionId}
                    onClick={() => onSelectSession(session.id)}
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

export function AppSidebar({
  selectedAgentId,
  selectedSessionId,
  onSelectAgent,
  onSelectSession,
}: AppSidebarProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const { data: agents, isLoading, error } = useAgents()

  return (
    <Sidebar>
      <SidebarHeader className="h-12 border-b">
        <div className="flex items-center h-full px-2">
          <span className="text-lg font-bold">Super Agent</span>
        </div>
      </SidebarHeader>

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
                  <AgentMenuItem
                    key={agent.id}
                    agent={agent}
                    isSelected={agent.id === selectedAgentId}
                    selectedSessionId={selectedSessionId}
                    onSelectAgent={onSelectAgent}
                    onSelectSession={onSelectSession}
                  />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <CreateAgentDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </Sidebar>
  )
}
