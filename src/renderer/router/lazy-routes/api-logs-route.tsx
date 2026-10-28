import { ApiLogsView } from '@renderer/components/api-logs/api-logs-view'
import { useAgentSlug } from './use-agent-slug'

export function ApiLogsRoute() {
  const slug = useAgentSlug()
  if (!slug) return null
  return <ApiLogsView agentSlug={slug} />
}
