
import { useAgents } from '@renderer/hooks/use-agents'
import { AgentListItem } from './agent-list-item'
import { Loader2 } from 'lucide-react'

interface AgentListProps {
  selectedAgentSlug: string | null
  onSelectAgent: (agentSlug: string) => void
}

export function AgentList({ selectedAgentSlug, onSelectAgent }: AgentListProps) {
  const { data: agents, isLoading, error } = useAgents()

  if (isLoading) {
    return (
      <div className="p-4 flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load agents
      </div>
    )
  }

  if (!agents?.length) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No agents yet. Create one to get started.
      </div>
    )
  }

  return (
    <div className="p-2 space-y-1">
      {agents.map((agent) => (
        <AgentListItem
          key={agent.slug}
          agent={agent}
          selected={agent.slug === selectedAgentSlug}
          onClick={() => onSelectAgent(agent.slug)}
        />
      ))}
    </div>
  )
}
