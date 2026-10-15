import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn() }))
const platform = vi.hoisted(() => ({ token: 'platform-token' as string | null }))
vi.mock('../../services/platform-auth-service', () => ({ getPlatformAccessToken: () => platform.token }))
const outbound = vi.hoisted(() => ({ check: vi.fn(async () => true) }))
vi.mock('./mcp', () => ({ checkGitHubMcp: outbound.check }))
vi.mock('../../webhook-relay', async importOriginal => ({ ...await importOriginal<object>(), getWebhookRelay: () => relay }))
import { createFakeWebhookRelay } from '../../webhook-relay/testing/fake-webhook-relay'
import { IntegrationRelays } from '../../agent-integrations/relay-transport'
import { deliveryStore } from '../../agent-integrations/delivery-store'
import type { IntegrationInputEvent } from '../../agent-integrations/types'
import { createAgentIntegration, deleteAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { GitHubAgentIntegration } from './github-agent-integration'
import { configured, body, comment, delivery } from './test-fixtures'
import { readGitHubIntegration, updateGitHubConfig } from './store'
const relay = createFakeWebhookRelay()
let connections: IntegrationRelays
let integration: GitHubAgentIntegration
let id: string
let events: IntegrationInputEvent[]
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db; relay.reset(); platform.token = 'platform-token'
  outbound.check.mockReset().mockResolvedValue(true)
  connections = new IntegrationRelays(() => relay)
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'github', config: configured })
  events = []
  fetchMock = vi.fn<typeof fetch>(async input => {
    const url = String(input)
    if (url.includes('/access_tokens')) return Response.json({ token: 'access', expires_at: new Date(Date.now() + 3600000).toISOString() })
    if (url.endsWith('/permission')) return Response.json({ permission: 'write' })
    if (url.endsWith('/reactions')) return Response.json({ id: 1 })
    throw new Error(`Unexpected request ${url}`)
  }); vi.stubGlobal('fetch', fetchMock)
  await connect()
})
async function connect() {
  integration = new GitHubAgentIntegration((await getAgentIntegration(id))!)
  integration.bindHost({ session: async () => undefined, relay: connections.hostFor(id) })
  integration.onEvent(async event => {
    if (event.type !== 'input') throw new Error('Unexpected non-input event')
    const result = await deliveryStore.accept(id, event, integration.resolveRoute(event))
    if (result === 'accepted') { events.push(event); await integration.acknowledgeInput(event) }
    return result
  })
  await integration.connect()
}
afterEach(async () => { await integration.disconnect(); connections.remove(id); await handle.close(); vi.unstubAllGlobals() })
const send = (items = [delivery()]) => relay.deliver(`integration:${id}`, items)
it('requires both platform and relay availability and attaches exactly one relay consumer', () => {
  expect(GitHubAgentIntegration.isAvailable()).toBe(true)
  platform.token = null; expect(GitHubAgentIntegration.isAvailable()).toBe(false)
  platform.token = 'token'; relay.setSnapshot({ ...relay.snapshot(), available: false })
  expect(GitHubAgentIntegration.isAvailable()).toBe(false)
  expect(relay.consumers.size).toBe(1)
  expect(integration.isConnected()).toBe(true)
  expect(fetchMock).toHaveBeenCalledOnce() // No polling/history on connect.
})
it('accepts once, acknowledges once, and follows immediate comments before session creation', async () => {
  const followup = delivery({ ...body, comment: { ...comment, id: 12, body: 'And include tests' } }, 'issue_comment', 'followup')
  expect([...(await send([delivery(), delivery(), followup])).values()]).toEqual(['duplicate', 'accepted'])
  expect(events.map(event => event.id)).toEqual(['github:delivery-1', 'github:followup'])
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reactions'))).toHaveLength(2)
  await integration.disconnect(); await connect()
  await send([delivery({ ...body, comment: { ...comment, id: 13, body: 'One more thing' } }, 'issue_comment', 'restart')])
  expect(events).toHaveLength(3)
})
it('discards wrong signatures, installations, bot messages, and unauthorized repository readers', async () => {
  const items = [delivery(body, 'issue_comment', 'bad-signature', 'wrong'), delivery({ ...body, installation: { id: 999 } }, 'issue_comment', 'wrong-install'),
    delivery({ ...body, sender: { id: 8, login: 'other[bot]', type: 'Bot' } }, 'issue_comment', 'bot')]
  expect([...(await send(items)).values()]).toEqual(['discard', 'discard', 'discard'])
  fetchMock.mockResolvedValueOnce(Response.json({ permission: 'read' }))
  expect([...(await send()).values()]).toEqual(['discard'])
  expect(events).toEqual([])
})
it.each([false, true])('accepts unmentioned comments on app-authored work (PR=%s), with the same access gate', async isPullRequest => {
  const ownIssue = { ...body.issue, user: { id: 9, login: 'release-helper[bot]', type: 'Bot' }, ...(isPullRequest ? { pull_request: {} } : {}) }
  const followup = { ...body, issue: ownIssue, comment: { ...comment, body: 'Please update the docs' } }
  fetchMock.mockResolvedValueOnce(Response.json({ permission: 'read' }))
  expect([...(await send([delivery(followup)])).values()]).toEqual(['discard'])
  expect(events).toEqual([])
  expect([...(await send([delivery(followup)])).values()]).toEqual(['accepted'])
  expect(events).toHaveLength(1)
  expect(integration.resolveRoute(events[0])).toMatchObject({ externalId: 'team/project#3', action: 'run', replyTarget: {} })
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reactions'))).toHaveLength(1)
})
it('leaves retry to the shared relay during outages and never cancels on state changes', async () => {
  outbound.check.mockResolvedValue(false)
  expect([...(await send()).values()]).toEqual(['retry'])
  outbound.check.mockResolvedValue(true)
  await send()
  expect([...(await send([delivery({ ...body, action: 'closed' }, 'issues', 'closed')])).values()]).toEqual(['discard'])
  expect(events).toHaveLength(1)
})
it('does not accept work after disconnecting during the permission check', async () => {
  let release!: (response: Response) => void
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const request = send()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  await integration.disconnect(); release(Response.json({ permission: 'write' }))
  expect([...(await request).values()]).toEqual(['retry'])
  expect(events).toEqual([])
})
it('stops old callbacks after reauthorization and contains deletion failures', async () => {
  await updateGitHubConfig(id, config => ({ ...config, authorizationVersion: 'replacement' }))
  expect([...(await send()).values()]).toEqual(['retry'])
  await deleteAgentIntegration(id)
  expect([...(await send()).values()]).toEqual(['retry'])
  expect(events).toEqual([])
})
it('turns signed installation removal into reconnect-needed through the shared lifecycle', async () => {
  await send([delivery({ action: 'deleted', installation: { id: 456 } }, 'installation')])
  const current = await readGitHubIntegration(id)
  expect(current.row.status).toBe('disconnected')
  expect(current.config.authorizationError).toContain('Reconnect')
})
