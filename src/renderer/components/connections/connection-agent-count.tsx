import { useAccountAgents } from '@renderer/hooks/use-connected-accounts'
import { useMcpAgents } from '@renderer/hooks/use-remote-mcps'

interface ConnectionAgentCountProps {
  type: 'oauth' | 'mcp'
  id: string
}

/**
 * Plain-text "N agent(s)" snippet for the connection row subtitle. Replaces
 * the dropdown pill on the connection list — the row click opens the detail
 * page where agent access can be edited.
 */
export function ConnectionAgentCount({ type, id }: ConnectionAgentCountProps) {
  const accountAgents = useAccountAgents(type === 'oauth' ? id : '')
  const mcpAgents = useMcpAgents(type === 'mcp' ? id : '')
  const data = type === 'oauth' ? accountAgents.data : mcpAgents.data
  // Render nothing until the query resolves so rows don't flash "Not in use".
  if (!data) return null
  const count = data.agentSlugs.length
  if (count === 0) {
    return <span className="whitespace-nowrap shrink-0">Not in use</span>
  }
  return (
    <span className="whitespace-nowrap shrink-0 tabular-nums">
      Used by {count} {count === 1 ? 'agent' : 'agents'}
    </span>
  )
}
