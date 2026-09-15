import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/** Session ID comes from the SDK closure, never from model tool arguments. */
export function integrationTools(getSessionId: () => string) {
  async function call(op: 'list' | 'execute', args: Record<string, unknown>) {
    const base = process.env.SUPERAGENT_HOST_API_URL
    const token = process.env.PROXY_TOKEN
    if (!base || !token) throw new Error('Integration host is unavailable')
    const response = await fetch(`${base.replace(/\/$/, '')}/x-agent/integration-tools/${op}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: getSessionId(), ...args }), signal: AbortSignal.timeout(60000),
    })
    const data: unknown = await response.json()
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], ...(!response.ok ? { isError: true } : {}) }
  }
  return [
    tool('list_integration_tools', 'List operations available for the external issue or conversation bound to this session, including input schemas. Returns an empty list in ordinary sessions.', {}, async () => call('list', {})),
    tool('execute_integration_tool', 'Execute an operation returned by list_integration_tools, using its input schema. The host binds the destination to this session.', {
      name: z.string(), input: z.record(z.string(), z.unknown()),
    }, async input => call('execute', input)),
  ]
}
