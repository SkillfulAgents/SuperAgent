import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { captureException } from '@shared/lib/error-reporting'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { IntegrationPolicyError } from '@shared/lib/agent-integrations/errors'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
const connector = vi.hoisted(() => ({ execute: vi.fn(async (_input: unknown) => ({ done: true })) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: {
  pauseIntegration: vi.fn(async () => {}), isIntegrationConnected: () => true, addIntegration: vi.fn(async () => {}), integrationCreated: vi.fn(),
  getConnector: () => ({ getTools: () => [
    { name: 'join', exposure: 'both', description: '', inputSchema: {}, execute: connector.execute },
    { name: 'internal', description: '', inputSchema: {}, execute: connector.execute },
  ] }),
} }))
vi.mock('../middleware/auth', () => ({
  getAuthorizedAgentRole: () => 'owner',
  hasMinRole: () => true,
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  AgentAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (_c: unknown, next: () => Promise<void>) => next(), getAgentId: () => 'agent',
  EntityAgentRole: (options: { lookupFn: (id: string) => Promise<unknown>; contextKey: string }) => () => async (c: any, next: () => Promise<void>) => {
    const row = await options.lookupFn(c.req.param('integrationId'))
    if (!row) return c.json({ error: 'Not found' }, 404)
    c.set(options.contextKey, row); await next()
  },
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'owner' }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn(async () => {}) }))
import { agentIntegrationRegistry } from '@shared/lib/agent-integrations/registry'
import { createAgentIntegration } from '@shared/lib/services/agent-integration-service'
import router from './agent-integrations'

const availability = vi.hoisted(() => ({ value: true }))
agentIntegrationRegistry.register({
  definition: { provider: 'test-gated', name: 'Gated', family: 'meeting', managementAccess: 'owner', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } },
  policy: { isAllowed: async () => true, sessionPolicy: () => ({ name: 'Gated', metadata: {} }) },
  isAvailable: () => availability.value,
  setup: { prepare: async () => ({ config: {} }) },
  create: async () => { throw new Error('not needed') },
  serialize: row => ({ ...row, config: undefined, settings: {}, hasCredentials: true }),
})
const app = new Hono().route('/api/agent-integrations', router)
const json = { 'Content-Type': 'application/json' }
beforeEach(async () => { vi.clearAllMocks(); availability.value = true; handle = await createTestDatabase(); testDb = handle.db })
afterEach(async () => { await handle.close() })

describe('provider availability', () => {
  it('offers only the providers this deployment can host, and refuses to install the others', async () => {
    const providers = async () => ((await (await app.request('/api/agent-integrations/providers')).json()) as Array<{ provider: string }>).map(entry => entry.provider)
    availability.value = false
    expect(await providers()).not.toContain('test-gated')
    const res = await app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers: json, body: JSON.stringify({ provider: 'test-gated', config: {} }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'This integration is unavailable on this host' })
    availability.value = true
    expect(await providers()).toContain('test-gated')
    expect((await app.request('/api/agent-integrations/agents/agent', { method: 'POST', headers: json, body: JSON.stringify({ provider: 'test-gated', config: {} }) })).status).toBe(201)
  })
})

describe('management tool invocation', () => {
  const invoke = async (tool: string, input: unknown = {}) => {
    const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'test-gated', config: {} })
    return app.request(`/api/agent-integrations/${id}/tools/${tool}`, { method: 'POST', headers: json, body: JSON.stringify({ input }) })
  }
  it('runs a management-exposed tool and returns its result', async () => {
    const res = await invoke('join', { meetingUrl: 'x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: { done: true } })
    expect(connector.execute).toHaveBeenCalledWith({ meetingUrl: 'x' }, { source: 'management', userId: 'owner' })
  })
  it('hides agent-only tools', async () => {
    expect((await invoke('internal')).status).toBe(404)
  })
  it("answers a family's refusal with 400 and its message, and anything else as a reported fault", async () => {
    connector.execute.mockRejectedValueOnce(new IntegrationPolicyError('The agent is not in a meeting right now.'))
    const refused = await invoke('join')
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'The agent is not in a meeting right now.' })
    expect(captureException).not.toHaveBeenCalled()
    class UpstreamError extends Error {}
    connector.execute.mockRejectedValueOnce(new UpstreamError('Recall.ai request failed (500)'))
    const failed = await invoke('join')
    expect(failed.status).toBe(500)
    expect(captureException).toHaveBeenCalledOnce()
  })
})
