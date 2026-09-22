import { CompletedTasksView } from '@renderer/components/agents/completed-tasks/completed-tasks-view'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentSlug } from './use-agent-slug'

export function CompletedTasksRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)

  if (!slug || !agent) return null
  return <CompletedTasksView agentSlug={agent.slug} />
}
