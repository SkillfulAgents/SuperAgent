import { InboundXAgentView } from '@renderer/components/agents/inbound-x-agent/inbound-x-agent-view'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentSlug } from './use-agent-slug'

export function InboundXAgentRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)
  if (!slug || !agent) return null
  return <InboundXAgentView agentSlug={agent.slug} />
}
