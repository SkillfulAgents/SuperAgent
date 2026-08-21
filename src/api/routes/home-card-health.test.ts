import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockBuildHomeCardHealth = vi.fn()
const mockGetHomeAgentScope = vi.fn()
const mockIsSessionActive = vi.fn()

vi.mock('@shared/lib/services/home-card-health-service', () => ({
  buildHomeCardHealth: (...args: unknown[]) => mockBuildHomeCardHealth(...args),
}))

vi.mock('./home-agent-scope', () => ({
  getHomeAgentScope: (...args: unknown[]) => mockGetHomeAgentScope(...args),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
  },
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
      isSessionLive: (sessionId: string) => boolean
    }
    mockIsSessionActive.mockReturnValue(true)
    expect(isSessionLive('session-1')).toBe(true)
    expect(mockIsSessionActive).toHaveBeenCalledWith('session-1')
  })

  it('returns a sanitized error when the batch build fails', async () => {
    mockBuildHomeCardHealth.mockRejectedValue(new Error('private filesystem path'))
    const response = await createApp().request('http://localhost/api/home-card-health')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to build home card health' })
  })
})
