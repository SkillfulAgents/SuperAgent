import { NewSessionView } from '@renderer/components/layout/new-session-view'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentSlug } from './use-agent-slug'

export function NewSessionRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)
  if (!slug || !agent) return null
  // Keyed so switching agents starts from a fresh composer.
  return <NewSessionView key={agent.slug} agent={agent} />
}
