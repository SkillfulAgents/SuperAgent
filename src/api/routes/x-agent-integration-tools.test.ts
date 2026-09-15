import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ token: vi.fn(), mapping: vi.fn(), integration: vi.fn(), connector: vi.fn(), execute: vi.fn(), getTools: vi.fn() }))
vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: mocks.token }))
vi.mock('@shared/lib/agent-integrations/store', () => ({ getIntegration: mocks.integration, getIntegrationSessionBySessionId: mocks.mapping }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: { getConnector: mocks.connector } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
import router from './x-agent-integration-tools'
beforeEach(() => {
  vi.clearAllMocks()
  mocks.token.mockResolvedValue('agent')
  mocks.mapping.mockReturnValue({ integrationId: 'integration', externalId: 'host-bound-issue', sessionId: 'sdk', archivedAt: null })
  mocks.integration.mockReturnValue({ id: 'integration', agentSlug: 'agent', status: 'active' })
  mocks.execute.mockResolvedValue({ changed: true })
  mocks.getTools.mockReturnValue([{ name: 'update_task', description: 'Edit', inputSchema: {}, execute: mocks.execute }])
  mocks.connector.mockReturnValue({ isConnected: () => true, isAllowed: () => true, getTools: mocks.getTools })
})
function post(body: unknown, token = 'token', op = 'execute') { return router.request(`/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
describe('session-bound integration tool gateway', () => {
  it('derives the task destination from the authenticated agent and SDK session mapping', async () => {
    const response = await post({ sessionId: 'sdk', name: 'update_task', input: { title: 'Changed' } })
    expect(response.status).toBe(200)
    expect(mocks.mapping).toHaveBeenCalledWith('agent', 'sdk')
    expect(mocks.getTools).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'host-bound-issue', sessionId: 'sdk' }))
    expect(mocks.execute).toHaveBeenCalledWith({ title: 'Changed' })
  })
  it('rejects forged destinations, cross-agent mappings, paused integrations and unknown tools', async () => {
    expect((await post({ sessionId: 'sdk', name: 'update_task', issueId: 'other' })).status).toBe(400)
    mocks.integration.mockReturnValue({ id: 'integration', agentSlug: 'other', status: 'active' })
    expect((await post({ sessionId: 'sdk', name: 'update_task' })).status).toBe(403)
    mocks.integration.mockReturnValue({ id: 'integration', agentSlug: 'agent', status: 'paused' })
    expect((await post({ sessionId: 'sdk', name: 'update_task' })).status).toBe(403)
    mocks.integration.mockReturnValue({ id: 'integration', agentSlug: 'agent', status: 'active' })
    expect((await post({ sessionId: 'sdk', name: 'arbitrary_graphql' })).status).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('rejects an invalid agent token before looking up any session', async () => {
    mocks.token.mockResolvedValue(null)
    expect((await post({ sessionId: 'sdk', name: 'update_task' })).status).toBe(401)
    expect(mocks.mapping).not.toHaveBeenCalled()
  })
})
