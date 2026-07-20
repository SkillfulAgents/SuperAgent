import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AgentRole } from '@shared/lib/types/agent'
import type { WebhookTrigger } from '@shared/lib/db/schema'

const mockGetWebhookTrigger = vi.fn()
const mockPauseWebhookTrigger = vi.fn()
const mockResumeWebhookTrigger = vi.fn()
const mockUpdateWebhookTriggerPrompt = vi.fn()
const mockUpdateWebhookTriggerRuntimeOptions = vi.fn()
const mockCancelWebhookTriggerWithCleanup = vi.fn()

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  getWebhookTrigger: (...args: unknown[]) => mockGetWebhookTrigger(...args),
  pauseWebhookTrigger: (...args: unknown[]) => mockPauseWebhookTrigger(...args),
  resumeWebhookTrigger: (...args: unknown[]) => mockResumeWebhookTrigger(...args),
  updateWebhookTriggerPrompt: (...args: unknown[]) => mockUpdateWebhookTriggerPrompt(...args),
  updateWebhookTriggerRuntimeOptions: (...args: unknown[]) => mockUpdateWebhookTriggerRuntimeOptions(...args),
  cancelWebhookTriggerWithCleanup: (...args: unknown[]) => mockCancelWebhookTriggerWithCleanup(...args),
}))

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionsByWebhookTrigger: vi.fn(() => []),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: { isSessionActive: vi.fn(() => false) },
}))

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: () => 'request-user',
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

const authState = vi.hoisted(() => ({ role: 'owner' as AgentRole }))
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAuthorizedAgentRole: (c: { get: (key: string) => AgentRole | undefined }) =>
    c.get('authorizedAgentRole') ?? null,
  EntityAgentRole: (opts: {
    paramName: string
    lookupFn: (id: string) => Promise<WebhookTrigger | null>
    contextKey: string
    entityName: string
  }) => () => async (c: {
    req: { param: (name: string) => string }
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
    json: (body: unknown, status?: number) => Response
  }, next: () => Promise<void>) => {
    const entity = await opts.lookupFn(c.req.param(opts.paramName))
    if (!entity) return c.json({ error: `${opts.entityName} not found` }, 404)
    c.set(opts.contextKey, entity)
    c.set('authorizedAgentRole', authState.role)
    return next()
  },
}))

import webhookTriggersRouter from './webhook-triggers'

const trigger: WebhookTrigger = {
  id: 'trigger-1',
  agentSlug: 'agent-1',
  kind: 'custom',
  composioTriggerId: 'whep_private-id',
  connectedAccountId: 'account-private-id',
  triggerType: 'CUSTOM_WEBHOOK',
  triggerConfig: JSON.stringify({ url: 'https://hooks.example.test/private-capability' }),
  prompt: 'Handle the event',
  name: 'Inbound events',
  status: 'active',
  lastFiredAt: null,
  fireCount: 0,
  lastSessionId: null,
  createdBySessionId: null,
  createdByUserId: 'owner-private-id',
  model: null,
  effort: null,
  speed: null,
  createdAt: new Date('2026-07-17T00:00:00Z'),
  cancelledAt: null,
  pausedAt: null,
}

function createApp() {
  const app = new Hono()
  app.route('/api/webhook-triggers', webhookTriggersRouter)
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  authState.role = 'owner'
  mockGetWebhookTrigger.mockResolvedValue(trigger)
  mockPauseWebhookTrigger.mockResolvedValue(true)
})

describe('webhook trigger response access', () => {
  it.each(['viewer', 'user'] as const)('redacts the detail response for %s members', async (role) => {
    authState.role = role

    const res = await createApp().request('http://localhost/api/webhook-triggers/trigger-1')
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).not.toHaveProperty('triggerConfig')
    expect(body).not.toHaveProperty('composioTriggerId')
    expect(body).not.toHaveProperty('connectedAccountId')
    expect(body).not.toHaveProperty('createdByUserId')
    expect(JSON.stringify(body)).not.toContain('private-capability')
  })

  it('retains capability fields in the detail response for owners', async () => {
    const res = await createApp().request('http://localhost/api/webhook-triggers/trigger-1')
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      triggerConfig: trigger.triggerConfig,
      composioTriggerId: 'whep_private-id',
      connectedAccountId: 'account-private-id',
      createdByUserId: 'owner-private-id',
    })
  })

  it('redacts refreshed rows returned after a user mutation', async () => {
    authState.role = 'user'

    const res = await createApp().request(
      'http://localhost/api/webhook-triggers/trigger-1/pause',
      { method: 'POST' },
    )
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).not.toHaveProperty('triggerConfig')
    expect(body).not.toHaveProperty('composioTriggerId')
    expect(body).not.toHaveProperty('connectedAccountId')
    expect(body).not.toHaveProperty('createdByUserId')
  })
})
