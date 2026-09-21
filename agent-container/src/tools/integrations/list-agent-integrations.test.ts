import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: () => Promise<unknown>) => ({ name, description, execute }) }))
import { listAgentIntegrationsTool } from './list-agent-integrations'
const execute = () => (listAgentIntegrationsTool as unknown as { execute(): Promise<{ content: Array<{ text: string }>; isError?: boolean }> }).execute()
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('uses the common authenticated endpoint and preserves non-chat identities and tool discovery', async () => {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  const fetch = vi.fn(async () => Response.json({ integrations: [{ id: 'account', provider: 'test-tracker', family: 'task-manager', name: 'Agent', status: 'paused', capabilities: ['mcp'], sessions: [],
    mcp: { name: 'agent_integration_account', status: 'active', identity: { name: 'Agent', provider: 'test-tracker', workspace: 'Team' }, tools: ['search'] } }] }))
  vi.stubGlobal('fetch', fetch)
  const result = await execute()
  expect(fetch).toHaveBeenCalledWith('https://host/api/x-agent/integrations/list', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }))
  expect(result.isError).toBeUndefined()
  expect(JSON.parse(result.content[0].text).integrations[0]).toMatchObject({ provider: 'test-tracker', status: 'paused', mcp: { tools: ['search'] } })
})
it('reports host authorization errors without treating them as an empty account list', async () => {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unauthorized' }, { status: 401 })))
  expect(await execute()).toMatchObject({ isError: true, content: [{ text: 'Failed to list agent integrations: Unauthorized' }] })
})
