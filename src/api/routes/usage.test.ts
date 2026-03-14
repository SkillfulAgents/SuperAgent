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
const mockCalculateCostFromTokens = vi.fn()

vi.mock('ccusage/data-loader', () => ({
  loadDailyUsageData: (...args: unknown[]) => mockLoadDailyUsageData(...args),
}))

vi.mock('ccusage/pricing-fetcher', () => ({
  PricingFetcher: class {
    calculateCostFromTokens = (...args: unknown[]) => mockCalculateCostFromTokens(...args)
  },
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

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: { userId: 'user_id', agentSlug: 'agent_slug' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
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

interface MockModelBreakdown {
  modelName: string
  cost: number
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

interface MockDayUsage {
  date: string
  totalCost: number
  modelBreakdowns: MockModelBreakdown[]
}

function makeAgent(slug: string, name: string): MockAgent {
  return { slug, frontmatter: { name } }
}

function makeDay(date: string, totalCost: number, models: MockModelBreakdown[] = []): MockDayUsage {
  return {
    date,
    totalCost,
    modelBreakdowns: models.map(m => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      ...m,
    })),
  }
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

  // =========================================================================
  // OpenRouter model name normalization
  // =========================================================================
  describe('model name normalization', () => {
    it('normalizes OpenRouter format "anthropic/claude-4.6-opus-20260205" to "claude-opus-4-6"', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [
          { modelName: 'anthropic/claude-4.6-opus-20260205', cost: 1.50 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(dayEntry.byModel).toHaveLength(1)
      expect(dayEntry.byModel[0].model).toBe('claude-opus-4-6')
    })

    it('normalizes "anthropic/claude-4.5-haiku-20251001" to "claude-haiku-4-5"', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [
          { modelName: 'anthropic/claude-4.5-haiku-20251001', cost: 0.50 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(dayEntry.byModel[0].model).toBe('claude-haiku-4-5')
    })

    it('normalizes "anthropic/claude-4.6-sonnet-20260115" to "claude-sonnet-4-6"', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [
          { modelName: 'anthropic/claude-4.6-sonnet-20260115', cost: 0.80 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(dayEntry.byModel[0].model).toBe('claude-sonnet-4-6')
    })

    it('does not modify standard Anthropic model names', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [
          { modelName: 'claude-opus-4-6', cost: 2.00 },
          { modelName: 'claude-haiku-4-5', cost: 0.30 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      const models = dayEntry.byModel.map((m: { model: string }) => m.model).sort()
      expect(models).toEqual(['claude-haiku-4-5', 'claude-opus-4-6'])
    })

    it('merges costs when OpenRouter name normalizes to existing canonical name', async () => {
      const agent1 = makeAgent('agent-1', 'Agent One')
      const agent2 = makeAgent('agent-2', 'Agent Two')
      mockListAgents.mockResolvedValue([agent1, agent2])
      mockGetAgentClaudeConfigDir.mockImplementation((slug: string) => `/data/agents/${slug}/.claude`)

      // agent-1 uses Anthropic directly, agent-2 uses OpenRouter — same model
      mockLoadDailyUsageData
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 2.00, [
            { modelName: 'claude-opus-4-6', cost: 2.00 },
          ]),
        ])
        .mockResolvedValueOnce([
          makeDay('2025-01-15', 1.00, [
            { modelName: 'anthropic/claude-4.6-opus-20260205', cost: 1.00 },
          ]),
        ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      // Should be merged under one model name
      expect(dayEntry.byModel).toHaveLength(1)
      expect(dayEntry.byModel[0].model).toBe('claude-opus-4-6')
      expect(dayEntry.byModel[0].cost).toBe(3.00)
    })

    it('preserves unknown model names as-is', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [
          { modelName: 'some-other-model', cost: 0.10 },
        ]),
      ])

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      expect(dayEntry.byModel[0].model).toBe('some-other-model')
    })
  })

  // =========================================================================
  // Cost recalculation for unpriced OpenRouter models
  // =========================================================================
  describe('cost recalculation for unpriced models', () => {
    it('recalculates cost when ccusage returned 0 but normalized name has pricing', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      // ccusage returns cost=0 because it couldn't price the OpenRouter model name
      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [{
          modelName: 'anthropic/claude-4.6-opus-20260205',
          cost: 0,
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }]),
      ])

      // PricingFetcher returns a recalculated cost for the normalized name
      mockCalculateCostFromTokens.mockResolvedValue(0.0175)

      const res = await getUsage('days=7')
      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      // Should have called calculateCostFromTokens with normalized name
      expect(mockCalculateCostFromTokens).toHaveBeenCalledWith(
        {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        'claude-opus-4-6'
      )

      // Cost should be the recalculated value
      expect(dayEntry.byModel[0].cost).toBe(0.0175)
      // totalCost and agent cost should also be updated
      expect(dayEntry.totalCost).toBe(0.0175)
      expect(dayEntry.byAgent[0].cost).toBe(0.0175)
    })

    it('does not recalculate when model name did not change after normalization', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      // Standard model with cost=0 (no normalization needed)
      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [{
          modelName: 'claude-opus-4-6',
          cost: 0,
          inputTokens: 1000,
          outputTokens: 500,
        }]),
      ])

      const res = await getUsage('days=7')
      await res.json()

      // Should NOT try to recalculate — name didn't change
      expect(mockCalculateCostFromTokens).not.toHaveBeenCalled()
    })

    it('does not recalculate when all tokens are zero', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [{
          modelName: 'anthropic/claude-4.6-opus-20260205',
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }]),
      ])

      const res = await getUsage('days=7')
      await res.json()

      // No tokens → no recalculation
      expect(mockCalculateCostFromTokens).not.toHaveBeenCalled()
    })

    it('does not recalculate when ccusage already priced the model (cost > 0)', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 1.50, [{
          modelName: 'anthropic/claude-4.6-opus-20260205',
          cost: 1.50,
          inputTokens: 10000,
          outputTokens: 5000,
        }]),
      ])

      const res = await getUsage('days=7')
      await res.json()

      // ccusage already computed a cost, no recalculation needed
      expect(mockCalculateCostFromTokens).not.toHaveBeenCalled()
    })

    it('handles pricing fetcher failure gracefully', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [{
          modelName: 'anthropic/claude-4.6-opus-20260205',
          cost: 0,
          inputTokens: 1000,
          outputTokens: 500,
        }]),
      ])

      mockCalculateCostFromTokens.mockRejectedValue(new Error('Pricing unavailable'))

      const res = await getUsage('days=7')
      expect(res.status).toBe(200)

      const body = await res.json()
      const dayEntry = body.daily.find((d: { date: string }) => d.date === '2025-01-15')

      // Should keep cost as 0 without crashing
      expect(dayEntry.byModel[0].cost).toBe(0)
    })

    it('includes cache tokens in recalculation', async () => {
      const agent = makeAgent('agent-1', 'Agent One')
      mockListAgents.mockResolvedValue([agent])
      mockGetAgentClaudeConfigDir.mockReturnValue('/data/agents/agent-1/.claude')

      mockLoadDailyUsageData.mockResolvedValue([
        makeDay('2025-01-15', 0, [{
          modelName: 'anthropic/claude-4.6-opus-20260205',
          cost: 0,
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationTokens: 5000,
          cacheReadTokens: 10000,
        }]),
      ])

      mockCalculateCostFromTokens.mockResolvedValue(0.05)

      const res = await getUsage('days=7')
      await res.json()

      expect(mockCalculateCostFromTokens).toHaveBeenCalledWith(
        {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 10000,
        },
        'claude-opus-4-6'
      )
    })
  })
})
