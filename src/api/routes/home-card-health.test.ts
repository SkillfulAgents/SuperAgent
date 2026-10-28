import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockBuildHomeCardHealth = vi.fn()
const mockGetHomeAgentScope = vi.fn()
const mockActiveIds = vi.fn((_slug: string): string[] => [])

vi.mock('@shared/lib/services/home-card-health-service', () => ({
  buildHomeCardHealth: (...args: unknown[]) => mockBuildHomeCardHealth(...args),
}))

vi.mock('./home-agent-scope', () => ({
  getHomeAgentScope: (...args: unknown[]) => mockGetHomeAgentScope(...args),
}))

vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
    activeIds: (slug) => mockActiveIds(slug),
  }),
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

import homeCardHealth from './home-card-health'

function createApp() {
  const app = new Hono()
  app.route('/api/home-card-health', homeCardHealth)
  return app
}

describe('home card health API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetHomeAgentScope.mockResolvedValue({
      agentSlugs: ['agent-a', 'agent-b'],
      userId: 'user-123',
    })
    mockBuildHomeCardHealth.mockResolvedValue({
      days: 14,
      generatedAt: '2026-07-30T12:00:00.000Z',
      crons: [],
      webhooks: [],
      cronByTaskId: {},
      webhookByTriggerId: {},
    })
  })

  it('passes the visible agent scope and normalized activity window to one batch build', async () => {
    mockActiveIds.mockImplementation((slug) => (slug === 'agent-a' ? ['session-1'] : []))
    const response = await createApp().request(
      'http://localhost/api/home-card-health?days=999&tz=-540',
    )

    expect(response.status).toBe(200)
    expect(mockBuildHomeCardHealth).toHaveBeenCalledWith({
      agentSlugs: ['agent-a', 'agent-b'],
      days: 30,
      tzOffsetMinutes: -540,
      isSessionLive: expect.any(Function),
    })

    const { isSessionLive } = mockBuildHomeCardHealth.mock.calls[0][0] as {
      isSessionLive: (agentSlug: string, sessionId: string) => boolean
    }
    // Each agent's active sessions, read once for the whole build.
    expect(mockActiveIds).toHaveBeenCalledWith('agent-a')
    expect(mockActiveIds).toHaveBeenCalledWith('agent-b')
    expect(isSessionLive('agent-a', 'session-1')).toBe(true)
    expect(isSessionLive('agent-b', 'session-1')).toBe(false)
  })

  it('returns a sanitized error when the batch build fails', async () => {
    mockBuildHomeCardHealth.mockRejectedValue(new Error('private filesystem path'))
    const response = await createApp().request('http://localhost/api/home-card-health')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to build home card health' })
  })
})
