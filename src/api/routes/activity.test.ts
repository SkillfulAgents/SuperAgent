import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockGetAgentActivityStats = vi.fn()
const mockGetConnectionActivityStats = vi.fn()
const mockIsSessionActive = vi.fn()

vi.mock('@shared/lib/services/activity-stats-service', () => ({
  getAgentActivityStats: (...args: unknown[]) => mockGetAgentActivityStats(...args),
  getConnectionActivityStats: (...args: unknown[]) => mockGetConnectionActivityStats(...args),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
  },
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
    expect(mockGetAgentActivityStats).toHaveBeenCalledWith('canonical-agent-id', {
      days: 14,
      tzOffsetMinutes: 0,
      isSessionLive: expect.any(Function),
    })
  })

  it('probes execution liveness (isSessionActive, not subscription) through the message persister', async () => {
    await createApp().request('http://localhost/api/activity/agents/agent-a')

    const { isSessionLive } = mockGetAgentActivityStats.mock.calls[0][1] as {
      isSessionLive: (sessionId: string) => boolean
    }
    mockIsSessionActive.mockReturnValue(true)
    expect(isSessionLive('session-1')).toBe(true)
    expect(mockIsSessionActive).toHaveBeenCalledWith('session-1')

    // An idle-but-still-subscribed session is NOT live — a persisted
    // 'running' for it must downgrade instead of pulsing forever.
    mockIsSessionActive.mockReturnValue(false)
    expect(isSessionLive('session-1')).toBe(false)
  })

  it.each([
    ['?days=1', 7],
    ['?days=30', 30],
    ['?days=999', 30],
    ['?days=nope', 14],
  ])('normalizes the requested window %s to %i days', async (query, days) => {
    await createApp().request(`http://localhost/api/activity/agents/agent-a${query}`)
    expect(mockGetAgentActivityStats).toHaveBeenCalledWith('agent-a', expect.objectContaining({ days }))
  })

  it.each([
    ['?tz=300', 300],
    ['?tz=-540', -540],
    ['?tz=99999', 840],
    ['?tz=-99999', -840],
    ['?tz=abc', 0],
  ])('normalizes the requested tz offset %s to %i minutes', async (query, tzOffsetMinutes) => {
    await createApp().request(`http://localhost/api/activity/agents/agent-a${query}`)
    expect(mockGetAgentActivityStats).toHaveBeenCalledWith('agent-a', expect.objectContaining({ tzOffsetMinutes }))
  })

  it('scopes global connection stats to the authenticated owner', async () => {
    const response = await createApp().request('http://localhost/api/activity/connections?days=10&tz=300')

    expect(response.status).toBe(200)
    expect(mockGetConnectionActivityStats).toHaveBeenCalledWith({
      days: 10,
      tzOffsetMinutes: 300,
      ownerId: 'user-123',
    })
  })

  it('returns a sanitized error when aggregation fails', async () => {
    mockGetAgentActivityStats.mockRejectedValue(new Error('database path and secret'))
    const response = await createApp().request('http://localhost/api/activity/agents/agent-a')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to fetch activity statistics' })
  })
})
