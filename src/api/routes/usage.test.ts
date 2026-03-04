import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockListAgents = vi.fn()
const mockGetAgent = vi.fn()

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
}))

const mockGetAgentClaudeConfigDir = vi.fn()

vi.mock('@shared/lib/utils/file-storage', () => ({
  getAgentClaudeConfigDir: (...args: unknown[]) => mockGetAgentClaudeConfigDir(...args),
}))

const mockLoadDailyUsageData = vi.fn()

vi.mock('ccusage/data-loader', () => ({
  loadDailyUsageData: (...args: unknown[]) => mockLoadDailyUsageData(...args),
}))

const mockIsAuthMode = vi.fn()

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: (...args: unknown[]) => mockIsAuthMode(...args),
}))

const mockGetCurrentUserId = vi.fn()

vi.mock('@shared/lib/auth/config', () => ({
  getCurrentUserId: (...args: unknown[]) => mockGetCurrentUserId(...args),
}))

// Auth middleware: no-op in tests
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

// Mock DB
const mockDbWhere = vi.fn()
const mockDbFrom = vi.fn()
const mockSttGroupBy = vi.fn().mockResolvedValue([])
const mockSttWhere = vi.fn().mockReturnValue({ groupBy: mockSttGroupBy })
const mockSttFrom = vi.fn().mockReturnValue({ where: mockSttWhere })
const mockSttSelect = vi.fn().mockReturnValue({ from: mockSttFrom })

vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => {
      // If called with stt-shaped fields (has 'date' key), route to STT mock chain
      if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && 'date' in (args[0] as Record<string, unknown>)) {
        return mockSttSelect(...args)
      }
      return { from: mockDbFrom }
    },
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: { userId: 'user_id', agentSlug: 'agent_slug' },
  sttUsage: { createdAt: 'created_at', model: 'model', agentSlug: 'agent_slug', cost: 'cost_micro', userId: 'user_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  gte: (col: string, val: unknown) => ({ col, val, op: 'gte' }),
  and: (...conditions: unknown[]) => conditions,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values, as: () => 'sql' }),
}))

import usage from './usage'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono()
  app.route('/api/usage', usage)
  return app
}

interface MockAgent {
  slug: string
  frontmatter: { name: string }
}

interface MockDayUsage {
  date: string
  totalCost: number
  modelBreakdowns: Array<{ modelName: string; cost: number }>
}

function makeAgent(slug: string, name: string): MockAgent {
  return { slug, frontmatter: { name } }
}

function makeDay(date: string, totalCost: number, models: Array<{ modelName: string; cost: number }> = []): MockDayUsage {
  return { date, totalCost, modelBreakdowns: models }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usage route', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthMode.mockReturnValue(false)
    mockListAgents.mockResolvedValue([])
    mockLoadDailyUsageData.mockResolvedValue([])
    app = createApp()
  })

  async function getUsage(query = ''): Promise<Response> {
    return app.request(`http://localhost/api/usage${query ? '?' + query : ''}`)
  }

  // =========================================================================
  // Basic aggregation from multiple agents
  // =========================================================================
  describe('basic aggregation', () => {
    it('returns empty daily array when no agents exist', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage()
      expect(res.status).toBe(200)

      const body = await res.json()
      // Should have gap-filled dates but all zero cost
      expect(body.daily).toBeDefined()
      expect(Array.isArray(body.daily)).toBe(true)
      for (const entry of body.daily) {
        expect(entry.totalCost).toBe(0)
      }
    })

    it('aggregates usage data from a single agent', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 1.50, [{ modelName: 'claude-sonnet', cost: 1.50 }]),
      ])

      const res = await getUsage('days=7')
      expect(res.status).toBe(200)

      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')
      expect(dayEntry).toBeDefined()
      expect(dayEntry.totalCost).toBe(1.50)
      expect(dayEntry.byAgent).toEqual([
        { agentSlug: 'agent-1', agentName: 'Agent One', cost: 1.50 },
      ])
      expect(dayEntry.byModel).toEqual([
        { model: 'claude-sonnet', cost: 1.50 },
      ])
    })

    it('aggregates usage data from multiple agents on the same date', async () => {
      const agent1 = makeAgent('agent-1', 'Agent One')
      const agent2 = makeAgent('agent-2', 'Agent Two')
      mockListAgents.mockResolvedValue([agent1, agent2])
      mockGetAgentClaudeConfigDir.mockImplementation((slug: string) => `/data/agents/${slug}/.claude`)

      // First call for agent-1, second for agent-2
      mockLoadDailyUsageData
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 2.00, [{ modelName: 'claude-sonnet', cost: 2.00 }]),
        ])
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 3.00, [{ modelName: 'claude-haiku', cost: 3.00 }]),
        ])

      const res = await getUsage('days=7')
      expect(res.status).toBe(200)

      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')
      expect(dayEntry).toBeDefined()
      expect(dayEntry.totalCost).toBe(5.00)
      expect(dayEntry.byAgent).toHaveLength(2)
      expect(dayEntry.byModel).toHaveLength(2)
    })
  })

  // =========================================================================
  // Grouping by date, agent, and model
  // =========================================================================
  describe('grouping by date, agent, and model', () => {
    it('groups data across different dates', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-14', 1.00, [{ modelName: 'claude-sonnet', cost: 1.00 }]),
        makeDay('2025-01-15', 2.00, [{ modelName: 'claude-sonnet', cost: 2.00 }]),
      ])

      const res = await getUsage('days=7')
      expect(res.status).toBe(200)

      const body = await res.json()
      const day14 = body.daily.find((d: { date: string }) => d.date === '2025-01-14')
      const day15 = body.daily.find((d: { date: string }) => d.date === '2025-01-15')
      expect(day14?.totalCost).toBe(1.00)
      expect(day15?.totalCost).toBe(2.00)
    })

    it('groups multiple models within same date correctly', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 5.00, [
          { modelName: 'claude-sonnet', cost: 3.00 },
          { modelName: 'claude-haiku', cost: 2.00 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      const sonnet = dayEntry.byModel.find((m: { model: string }) => m.model === 'claude-sonnet')
      const haiku = dayEntry.byModel.find((m: { model: string }) => m.model === 'claude-haiku')
      expect(sonnet.cost).toBe(3.00)
      expect(haiku.cost).toBe(2.00)
    })
  })

  // =========================================================================
  // Accumulation of costs
  // =========================================================================
  describe('accumulation of costs', () => {
    it('accumulates costs for same agent across its daily data on same date', async () => {
      // Two agents reporting on the same date with the same model
      const agent1 = makeAgent('agent-1', 'Agent One')
      const agent2 = makeAgent('agent-2', 'Agent Two')
      mockListAgents.mockResolvedValue([agent1, agent2])
      mockGetAgentClaudeConfigDir.mockImplementation((slug: string) => `/data/agents/${slug}/.claude`)

      mockLoadDailyUsageData
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 2.00, [{ modelName: 'claude-sonnet', cost: 2.00 }]),
        ])
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 3.00, [{ modelName: 'claude-sonnet', cost: 3.00 }]),
        ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      // Total cost accumulated across both agents
      expect(dayEntry.totalCost).toBe(5.00)
      // Model costs accumulated
      const sonnet = dayEntry.byModel.find((m: { model: string }) => m.model === 'claude-sonnet')
      expect(sonnet.cost).toBe(5.00)
    })

    it('accumulates costs when same agent has multiple daily entries for same date', async () => {
      // loadDailyUsageData could return multiple entries for the same date
      // (unlikely but the code handles it via the Map)
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 1.00, [{ modelName: 'claude-sonnet', cost: 1.00 }]),
        makeDay('2025-01-15', 2.00, [{ modelName: 'claude-sonnet', cost: 2.00 }]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(dayEntry.totalCost).toBe(3.00)
      // Agent cost accumulated
      const agentEntry = dayEntry.byAgent.find((a: { agentSlug: string }) => a.agentSlug === 'agent-1')
      expect(agentEntry.cost).toBe(3.00)
      // Model cost accumulated
      const sonnet = dayEntry.byModel.find((m: { model: string }) => m.model === 'claude-sonnet')
      expect(sonnet.cost).toBe(3.00)
    })
  })

  // =========================================================================
  // Date gap filling with zero-cost entries
  // =========================================================================
  describe('date gap filling', () => {
    it('fills missing dates with zero-cost entries', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage('days=3')
      expect(res.status).toBe(200)

      const body = await res.json()
      // Should have at least 3 entries (today, yesterday, day before)
      expect(body.daily.length).toBeGreaterThanOrEqual(3)
      for (const entry of body.daily) {
        expect(entry.totalCost).toBe(0)
        expect(entry.byAgent).toEqual([])
        expect(entry.byModel).toEqual([])
      }
    })

    it('gap-filled dates are sorted chronologically', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage('days=5')
      const body = await res.json()

      const dates = body.daily.map((d: { date: string }) => d.date)
      const sorted = [...dates].sort()
      expect(dates).toEqual(sorted)
    })
  })

  // =========================================================================
  // Parameter clamping (min 1, max 90, default 7)
  // =========================================================================
  describe('parameter clamping', () => {
    it('defaults to 7 days when no days param', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage()
      const body = await res.json()
      // Should produce approximately 7+ entries (7 days + today)
      expect(body.daily.length).toBeGreaterThanOrEqual(7)
      expect(body.daily.length).toBeLessThanOrEqual(9) // 7 days range + rounding
    })

    it('treats days=0 as default 7 (0 is falsy, falls through to || 7)', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage('days=0')
      const body = await res.json()
      // parseInt('0') = 0, which is falsy, so || 7 kicks in => 7 days
      expect(body.daily.length).toBeGreaterThanOrEqual(7)
      expect(body.daily.length).toBeLessThanOrEqual(9)
    })

    it('clamps negative to 1 day', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage('days=-5')
      const body = await res.json()
      expect(body.daily.length).toBeGreaterThanOrEqual(1)
      expect(body.daily.length).toBeLessThanOrEqual(3)
    })

    it('clamps maximum to 90 days', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage('days=200')
      const body = await res.json()
      // Should have at most ~91 entries (90 days + today)
      expect(body.daily.length).toBeLessThanOrEqual(92)
      expect(body.daily.length).toBeGreaterThanOrEqual(90)
    })

    it('defaults to 7 when days is non-numeric', async () => {
      mockListAgents.mockResolvedValue([])

      const res = await getUsage('days=abc')
      const body = await res.json()
      expect(body.daily.length).toBeGreaterThanOrEqual(7)
      expect(body.daily.length).toBeLessThanOrEqual(9)
    })
  })

  // =========================================================================
  // Global view authorization (admin only)
  // =========================================================================
  describe('global view authorization', () => {
    it('uses listAgents for non-auth mode', async () => {
      mockIsAuthMode.mockReturnValue(false)
      mockListAgents.mockResolvedValue([])

      await getUsage()

      expect(mockListAgents).toHaveBeenCalledOnce()
      expect(mockGetCurrentUserId).not.toHaveBeenCalled()
    })

    it('restricts to user agents in auth mode without global flag', async () => {
      mockIsAuthMode.mockReturnValue(true)
      mockGetCurrentUserId.mockReturnValue('user-123')
      mockDbFrom.mockReturnValue({ where: mockDbWhere })
      mockDbWhere.mockResolvedValue([{ agentSlug: 'my-agent' }])
      mockGetAgent.mockResolvedValue(makeAgent('my-agent', 'My Agent'))
      mockLoadDailyUsageData.mockResolvedValue([])

      // We need to mock the middleware to set the user on context
      // Recreate the app with user context
      const customApp = new Hono()
      // Add middleware that sets user
      customApp.use('*', async (c, next) => {
        c.set('user' as never, { id: 'user-123', role: 'member' } as never)
        return next()
      })
      customApp.route('/api/usage', usage)

      await customApp.request('http://localhost/api/usage')

      expect(mockListAgents).not.toHaveBeenCalled()
      expect(mockGetCurrentUserId).toHaveBeenCalled()
    })

    it('allows global view for admin in auth mode', async () => {
      mockIsAuthMode.mockReturnValue(true)
      mockListAgents.mockResolvedValue([])

      const customApp = new Hono()
      customApp.use('*', async (c, next) => {
        c.set('user' as never, { id: 'admin-1', role: 'admin' } as never)
        return next()
      })
      customApp.route('/api/usage', usage)

      await customApp.request('http://localhost/api/usage?global=true')

      // Admin with global=true should use listAgents (all agents)
      expect(mockListAgents).toHaveBeenCalledOnce()
    })

    it('does not allow global view for non-admin in auth mode', async () => {
      mockIsAuthMode.mockReturnValue(true)
      mockGetCurrentUserId.mockReturnValue('user-123')
      mockDbFrom.mockReturnValue({ where: mockDbWhere })
      mockDbWhere.mockResolvedValue([])
      mockLoadDailyUsageData.mockResolvedValue([])

      const customApp = new Hono()
      customApp.use('*', async (c, next) => {
        c.set('user' as never, { id: 'user-123', role: 'member' } as never)
        return next()
      })
      customApp.route('/api/usage', usage)

      await customApp.request('http://localhost/api/usage?global=true')

      // Non-admin should NOT use listAgents even with global=true
      expect(mockListAgents).not.toHaveBeenCalled()
      expect(mockGetCurrentUserId).toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Map-to-sorted-array transformation
  // =========================================================================
  describe('map-to-sorted-array transformation', () => {
    it('returns daily entries sorted by date ascending', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      // Return dates out of order to verify sorting
      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-17', 3.00, []),
        makeDay('2025-01-15', 1.00, []),
        makeDay('2025-01-16', 2.00, []),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()

      const dates = body.daily.map((d: { date: string }) => d.date)
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i] >= dates[i - 1]).toBe(true)
      }
    })

    it('converts byAgent map values to array', async () => {
      const agent1 = makeAgent('agent-1', 'Agent One')
      const agent2 = makeAgent('agent-2', 'Agent Two')
      mockListAgents.mockResolvedValue([agent1, agent2])
      mockGetAgentClaudeConfigDir.mockImplementation((slug: string) => `/data/agents/${slug}/.claude`)

      mockLoadDailyUsageData
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 1.00, []),
        ])
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 2.00, []),
        ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(Array.isArray(dayEntry.byAgent)).toBe(true)
      expect(dayEntry.byAgent).toHaveLength(2)
      // Each entry has the expected shape
      for (const agentUsage of dayEntry.byAgent) {
        expect(agentUsage).toHaveProperty('agentSlug')
        expect(agentUsage).toHaveProperty('agentName')
        expect(agentUsage).toHaveProperty('cost')
      }
    })

    it('converts byModel map entries to array of {model, cost}', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 5.00, [
          { modelName: 'claude-sonnet', cost: 3.00 },
          { modelName: 'claude-haiku', cost: 2.00 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(Array.isArray(dayEntry.byModel)).toBe(true)
      expect(dayEntry.byModel).toHaveLength(2)
      for (const modelUsage of dayEntry.byModel) {
        expect(modelUsage).toHaveProperty('model')
        expect(modelUsage).toHaveProperty('cost')
        expect(typeof modelUsage.model).toBe('string')
        expect(typeof modelUsage.cost).toBe('number')
      }
    })

    it('handles rejected agent promises gracefully (skips them)', async () => {
      const agent1 = makeAgent('agent-1', 'Agent One')
      const agent2 = makeAgent('agent-2', 'Agent Two')
      mockListAgents.mockResolvedValue([agent1, agent2])
      mockGetAgentClaudeConfigDir.mockImplementation((slug: string) => `/data/agents/${slug}/.claude`)

      // First agent succeeds, second rejects
      mockLoadDailyUsageData
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 2.00, [{ modelName: 'claude-sonnet', cost: 2.00 }]),
        ])
        .mockRejectedValueOnce(new Error('Failed to load usage'))

      const res = await getUsage('days=7')
      expect(res.status).toBe(200)

      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')
      // Only agent-1 data should be present
      expect(dayEntry.totalCost).toBe(2.00)
      expect(dayEntry.byAgent).toHaveLength(1)
      expect(dayEntry.byAgent[0].agentSlug).toBe('agent-1')
    })
  })
})
