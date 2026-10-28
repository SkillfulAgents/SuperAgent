import { XAgentPermissionsView } from '@renderer/components/agents/x-agent-permissions/x-agent-permissions-view'
import { useAgentSlug } from './use-agent-slug'

export function XAgentPermissionsRoute() {
  const slug = useAgentSlug()
  if (!slug) return null
  return <XAgentPermissionsView agentSlug={slug} />
}
