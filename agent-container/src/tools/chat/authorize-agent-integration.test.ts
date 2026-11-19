import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { authorizeAgentIntegrationTool, completeAgentIntegrationAuthorizationTool } from './authorize-agent-integration'

type Callable = { execute(input: object): Promise<{ content: { text: string }[]; isError?: boolean }> }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function host(status: number, body: unknown) {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })))
}
const call = () => vi.mocked(fetch).mock.calls[0]

it('returns the authorization link and how to finish when the callback cannot load', async () => {
  host(200, { url: 'https://linear.app/oauth/authorize?state=s1' })

  const result = await (authorizeAgentIntegrationTool as unknown as Callable).execute({ integration_id: 'lin-1', config: { clientId: 'id', clientSecret: 'secret' } })

  expect(call()[0]).toBe('https://host/api/x-agent/chat/authorize')
  expect(JSON.parse(call()[1]!.body as string)).toEqual({ integration_id: 'lin-1', config: { clientId: 'id', clientSecret: 'secret' } })
  expect(result.content[0].text).toContain('https://linear.app/oauth/authorize?state=s1')
  expect(result.content[0].text).toContain('complete_agent_integration_authorization with integration_id "lin-1"')
})

it('reports a refused authorization as an error', async () => {
  host(403, { error: 'Only the agent\'s owner can authorize this integration' })
  const result = await (authorizeAgentIntegrationTool as unknown as Callable).execute({ integration_id: 'mail-1' })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('Only the agent\'s owner')
})

it('hands the redirected address to the host and passes on a further step', async () => {
  host(200, { status: 'continue', url: 'https://github.com/apps/helper/installations/new?state=s1' })

  const result = await (completeAgentIntegrationAuthorizationTool as unknown as Callable).execute({ integration_id: 'gh-1', url: 'http://localhost:47891/api/agent-integrations/providers/github/callback?state=s1&code=c1' })

  expect(call()[0]).toBe('https://host/api/x-agent/chat/complete-authorization')
  expect(result.content[0].text).toContain('https://github.com/apps/helper/installations/new?state=s1')
})

it('reports the integration status once the callback completes', async () => {
  host(200, { status: 'active' })
  const result = await (completeAgentIntegrationAuthorizationTool as unknown as Callable).execute({ integration_id: 'lin-1', url: 'http://x/api/agent-integrations/providers/linear/callback?state=s1&code=c1' })
  expect(result.content[0].text).toBe('Authorization complete. Integration status: active.')
})
