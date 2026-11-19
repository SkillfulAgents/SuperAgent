import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { addAgentIntegrationTool } from './add-agent-integration'
import { listAvailableIntegrationProvidersTool } from './list-available-integration-providers'

type Callable = { execute(input: object): Promise<{ content: { text: string }[]; isError?: boolean }> }
const addTool = addAgentIntegrationTool as unknown as Callable
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function host(status: number, body: unknown) {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })))
}
const sentBody = () => JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)

it('creates the integration and reports it', async () => {
  host(201, { id: 'integration-1', provider: 'telegram', status: 'active', name: 'Bot' })

  const result = await addTool.execute({ provider: 'telegram', config: { botToken: 'token' }, name: 'Bot' })

  expect(sentBody()).toEqual({ provider: 'telegram', config: { botToken: 'token' }, name: 'Bot' })
  expect(result.isError).toBeFalsy()
  expect(result.content[0].text).toContain('ID: integration-1')
})

it('passes on the next step of a setup the agent finishes in its browser', async () => {
  host(201, { id: 'lin-1', provider: 'linear', status: 'disconnected', name: 'Helper', nextStep: 'Create this agent\'s Linear app: open https://linear.app/settings/api/applications/new in your browser.' })

  const result = await addTool.execute({ provider: 'linear', name: 'Helper', config: { webhooks: true } })

  expect(result.content[0].text).toContain('Status: disconnected')
  expect(result.content[0].text).toContain('Next step:\nCreate this agent\'s Linear app')
})

it('takes any provider the host names, and reports the host\'s refusal', async () => {
  host(400, { error: 'This integration is unavailable on this host' })
  const result = await addTool.execute({ provider: 'a-future-provider' })
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toBe('Failed to add agent integration: This integration is unavailable on this host')
})

it('lists the host\'s providers with their guides, and the ones this host cannot run', async () => {
  host(200, { webhookRelay: false, providers: [
    { provider: 'telegram', name: 'Telegram', guide: 'Required: `botToken`' },
    { provider: 'github', name: 'GitHub', unavailable: 'Needs a webhook relay, which this host does not have.' },
  ] })

  const result = await (listAvailableIntegrationProvidersTool as unknown as Callable).execute({})

  expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://host/api/x-agent/chat/providers')
  expect(result.content[0].text).toContain('## Telegram (provider `telegram`)\nRequired: `botToken`')
  expect(result.content[0].text).toContain('## GitHub (provider `github`)\nNeeds a webhook relay')
  expect(result.content[0].text).toContain('This host has no webhook relay.')
})
