import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockGetAgentActivityStats = vi.fn()
const mockGetConnectionActivityStats = vi.fn()

vi.mock('@shared/lib/services/activity-stats-service', () => ({
  getAgentActivityStats: (...args: unknown[]) => mockGetAgentActivityStats(...args),
  getConnectionActivityStats: (...args: unknown[]) => mockGetConnectionActivityStats(...args),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: any, next: () => Promise<void>) => {
    c.set('agentId', c.req.param('id') === 'display-agent' ? 'canonical-agent-id' : c.req.param('id'))
    return next()
  },
  AgentRead: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAgentId: (c: any) => c.get('agentId'),
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'user-123' }))

import activityRouter from './activity'

function createApp() {
  const app = new Hono()
  app.route('/api/activity', activityRouter)
  return app
}

describe('activity API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAgentActivityStats.mockResolvedValue({ days: 14, cronByTaskId: {}, webhookByTriggerId: {}, connectionById: {} })
    mockGetConnectionActivityStats.mockResolvedValue({ days: 14, connectionById: {} })
  })

  it('resolves the canonical agent, applies the default window, and returns scoped stats', async () => {
    const response = await createApp().request('http://localhost/api/activity/agents/display-agent')

    expect(response.status).toBe(200)
    expect(mockGetAgentActivityStats).toHaveBeenCalledWith('canonical-agent-id', { days: 14 })
  })

  it.each([
    ['?days=1', 7],
    ['?days=30', 30],
    ['?days=999', 30],
    ['?days=nope', 14],
  ])('normalizes the requested window %s to %i days', async (query, days) => {
    await createApp().request(`http://localhost/api/activity/agents/agent-a${query}`)
    expect(mockGetAgentActivityStats).toHaveBeenCalledWith('agent-a', { days })
  })

  it('scopes global connection stats to the authenticated owner', async () => {
    const response = await createApp().request('http://localhost/api/activity/connections?days=10')

    expect(response.status).toBe(200)
    expect(mockGetConnectionActivityStats).toHaveBeenCalledWith({ days: 10, ownerId: 'user-123' })
  })

  it('returns a sanitized error when aggregation fails', async () => {
    mockGetAgentActivityStats.mockRejectedValue(new Error('database path and secret'))
    const response = await createApp().request('http://localhost/api/activity/agents/agent-a')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to fetch activity statistics' })
  })
})
