import { AgentMemoriesView } from '@renderer/components/agents/agent-memories-view'
import { useAgentSlug } from './use-agent-slug'

export function MemoriesRoute() {
  const slug = useAgentSlug()
  return slug ? <AgentMemoriesView key={slug} agentSlug={slug} /> : null
}
