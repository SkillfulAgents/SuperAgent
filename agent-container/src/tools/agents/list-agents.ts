import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callHost, textResult, XAgentError } from './host-client'

interface ListAgentsResult {
  agents: Array<{ slug: string; name: string; description?: string }>
}

export const listAgentsTool = tool(
  'list_agents',
  `List the other agents in this workspace that you can interact with. Returns each agent's slug, name, and description.

Use this before invoke_agent to discover available agents. The list excludes yourself.

In auth mode, the list is filtered to agents the workspace owner has access to.`,
  {},
  async () => {
    try {
      const data = await callHost<ListAgentsResult>('list', {})
      if (data.agents.length === 0) {
        return textResult('No other agents available in this workspace.')
      }
      const lines = data.agents.map((a) => {
        const desc = a.description ? ` — ${a.description}` : ''
        return `- ${a.slug} (${a.name})${desc}`
      })
      return textResult(`Available agents (${data.agents.length}):\n${lines.join('\n')}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list agents: ${msg}`, true)
    }
  },
)
