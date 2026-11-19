import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { inputManager } from '../../input-manager'
import { makeAddAgentIntegrationTool } from './add-agent-integration'

type Callable = { execute(input: object): Promise<{ content: { text: string }[]; isError?: boolean }> }
const addTool = makeAddAgentIntegrationTool(() => 'caller-session') as unknown as Callable
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function host(status: number, body: unknown) {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })))
}
const sentBody = () => JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)

it('creates a provider the agent may set up and reports it', async () => {
  host(201, { id: 'integration-1', provider: 'telegram', status: 'active', name: 'Bot' })
  inputManager.setCurrentToolUseId('tool-direct', 'caller-session')

  const result = await addTool.execute({ provider: 'telegram', config: { botToken: 'token' }, name: 'Bot' })

  expect(sentBody()).toMatchObject({ provider: 'telegram', config: { botToken: 'token' }, toolUseId: 'tool-direct', sessionId: 'caller-session' })
  expect(result.isError).toBeFalsy()
  expect(result.content[0].text).toContain('ID: integration-1')
  expect(inputManager.hasPending('tool-direct')).toBe(false)
})

it('passes on the next step of a setup the agent finishes in its browser', async () => {
  host(201, { id: 'lin-1', provider: 'linear', status: 'disconnected', name: 'Helper', nextStep: 'Create this agent\'s Linear app: open https://linear.app/settings/api/applications/new in your browser.' })
  inputManager.setCurrentToolUseId('tool-linear', 'caller-session')

  const result = await addTool.execute({ provider: 'linear', name: 'Helper', config: { webhooks: true } })

  expect(result.content[0].text).toContain('Status: disconnected')
  expect(result.content[0].text).toContain('Next step:\nCreate this agent\'s Linear app')
  expect(inputManager.hasPending('tool-linear')).toBe(false)
})

it('waits on the owner for an owner-managed provider and returns their outcome', async () => {
  host(202, { status: 'owner_setup_requested', provider: 'platform-email' })
  inputManager.setCurrentToolUseId('tool-owner', 'caller-session')

  const pending = addTool.execute({ provider: 'platform-email', reason: 'Support inbox' })
  await vi.waitFor(() => expect(inputManager.hasPending('tool-owner')).toBe(true))
  inputManager.resolve('tool-owner', 'Email is set up (integration ID: integration-2).')

  expect((await pending).content[0].text).toBe('Email is set up (integration ID: integration-2).')
  expect(sentBody()).toMatchObject({ provider: 'platform-email', reason: 'Support inbox', toolUseId: 'tool-owner' })
})

it('reports a declined setup as an error', async () => {
  host(202, { status: 'owner_setup_requested', provider: 'platform-email' })
  inputManager.setCurrentToolUseId('tool-declined', 'caller-session')

  const pending = addTool.execute({ provider: 'platform-email' })
  await vi.waitFor(() => expect(inputManager.hasPending('tool-declined')).toBe(true))
  inputManager.reject('tool-declined', 'Use the shared inbox instead')

  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toBe('platform-email was not set up: Use the shared inbox instead')
})
