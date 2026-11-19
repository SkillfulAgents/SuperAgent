import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ tool: (name: string, description: string, _schema: unknown, execute: (input: unknown) => Promise<unknown>) => ({ name, description, execute }) }))
import { inputManager } from '../input-manager'
import { requestIntegrationSetupTool } from './request-integration-setup'

type Callable = { execute(input: object): Promise<{ content: { text: string }[]; isError?: boolean }> }
const request = requestIntegrationSetupTool as unknown as Callable
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function host(providers: unknown[]) {
  vi.stubEnv('SUPERAGENT_HOST_API_URL', 'https://host/api'); vi.stubEnv('PROXY_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ providers, webhookRelay: true })))
}

it('waits on the user and returns the host\'s answer once the integration connects', async () => {
  host([{ provider: 'slack', name: 'Slack', guide: 'steps', oneClickWorkspace: 'Acme' }])
  inputManager.setCurrentToolUseId('tool-handoff', 'session-1')

  const pending = request.execute({ provider: 'slack', reason: 'So the team can message me', prefill: { name: 'Helper' } })
  await vi.waitFor(() => expect(inputManager.hasPending('tool-handoff')).toBe(true))
  expect(inputManager.getAllPending().find((entry) => entry.toolUseId === 'tool-handoff')?.inputType).toBe('integration_setup')
  inputManager.resolve('tool-handoff', 'Slack is set up (integration ID: integration-2).')

  const result = await pending
  expect(result.isError).toBeFalsy()
  expect(result.content[0].text).toBe('Slack is set up (integration ID: integration-2).')
})

it('reports a declined setup as an error', async () => {
  host([{ provider: 'linear', name: 'Linear', guide: 'steps' }])
  inputManager.setCurrentToolUseId('tool-declined', 'session-1')

  const pending = request.execute({ provider: 'linear', reason: 'Triage' })
  await vi.waitFor(() => expect(inputManager.hasPending('tool-declined')).toBe(true))
  inputManager.reject('tool-declined', 'Use the shared bot instead')

  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toBe('linear was not set up: Use the shared bot instead')
})

it('does not show a card for a provider this host cannot set up', async () => {
  host([{ provider: 'github', name: 'GitHub', unavailable: 'Needs a webhook relay, which this host does not have.' }])

  inputManager.setCurrentToolUseId('tool-unavailable', 'session-1')
  const unavailable = await request.execute({ provider: 'github', reason: 'Reviews' })
  expect(unavailable.isError).toBe(true)
  expect(unavailable.content[0].text).toContain('GitHub cannot be set up on this host')

  inputManager.setCurrentToolUseId('tool-unknown', 'session-1')
  const unknown = await request.execute({ provider: 'nope', reason: 'Reviews' })
  expect(unknown.isError).toBe(true)
  expect(inputManager.hasPending('tool-unavailable')).toBe(false)
  expect(inputManager.hasPending('tool-unknown')).toBe(false)
})
