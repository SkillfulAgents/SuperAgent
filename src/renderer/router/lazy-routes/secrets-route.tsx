import { AgentSecretsView } from '@renderer/components/agents/agent-secrets/agent-secrets-view'
import { useAgentSlug } from './use-agent-slug'

export function SecretsRoute() {
  const slug = useAgentSlug()
  if (!slug) return null
  return <AgentSecretsView agentSlug={slug} />
}
