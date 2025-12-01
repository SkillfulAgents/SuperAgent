'use client'

import { Plus } from 'lucide-react'
import { useState } from 'react'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar'
import { useAgents } from '@/lib/hooks/use-agents'
import { CreateAgentDialog } from '@/components/agents/create-agent-dialog'
import { AgentStatus } from '@/components/agents/agent-status'

interface AppSidebarProps {
  selectedAgentId: string | null
  onSelectAgent: (agentId: string) => void
}

export function AppSidebar({ selectedAgentId, onSelectAgent }: AppSidebarProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const { data: agents, isLoading, error } = useAgents()

  return (
    <Sidebar>
      <SidebarHeader className="border-b">
        <div className="flex items-center px-2 py-1">
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
                  <SidebarMenuItem key={agent.id}>
                    <SidebarMenuButton
                      isActive={agent.id === selectedAgentId}
                      onClick={() => onSelectAgent(agent.id)}
                      className="justify-between"
                    >
                      <span className="truncate">{agent.name}</span>
                      <AgentStatus status={agent.status} />
                    </SidebarMenuButton>
                  </SidebarMenuItem>
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
