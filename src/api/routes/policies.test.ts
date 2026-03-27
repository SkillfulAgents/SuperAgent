import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockAll = vi.fn()
const mockWhere = vi.fn()
const mockDbFrom = vi.fn()
const mockInsertValues = vi.fn()
const mockOnConflictDoUpdate = vi.fn()

const mockDeleteWhere = vi.fn()
const mockDeleteRun = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({ from: mockDbFrom }),
    insert: () => ({ values: mockInsertValues }),
    delete: () => ({ where: mockDeleteWhere }),
    transaction: (fn: () => void) => fn(),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  apiScopePolicies: {
    accountId: 'account_id',
    scope: 'scope',
  },
  mcpToolPolicies: {
    mcpId: 'mcp_id',
    toolName: 'tool_name',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// Auth middleware passthrough
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  OwnsAccountByParam: () => async (_c: unknown, next: () => Promise<void>) => next(),
  OwnsMcpByParam: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

import policies from './policies'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp() {
  const app = new Hono()
  app.route('/api/policies', policies)
  return app
}

async function makeRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  options?: RequestInit
): Promise<Response> {
  return app.request(`http://localhost${path}`, options)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('policies routes', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockInsertValues.mockReturnValue({ run: vi.fn() })
    mockDeleteWhere.mockReturnValue({ run: mockDeleteRun })
  })

  // =========================================================================
  // Scope policies (API accounts)
  // =========================================================================
  describe('GET /api/policies/scope/:accountId', () => {
    it('returns policies for an account', async () => {
      const mockPolicies = [
        { id: 'p1', accountId: 'acc-1', scope: 'gmail.readonly', decision: 'allow', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'p2', accountId: 'acc-1', scope: '*', decision: 'review', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ]
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ all: mockAll })
      mockAll.mockReturnValue(mockPolicies)

      const res = await makeRequest(app, '/api/policies/scope/acc-1')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.policies).toHaveLength(2)
      expect(body.policies[0].scope).toBe('gmail.readonly')
      expect(body.policies[0].decision).toBe('allow')
      expect(body.policies[1].scope).toBe('*')
      expect(body.policies[1].decision).toBe('review')
    })

    it('returns empty array when no policies exist', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ all: mockAll })
      mockAll.mockReturnValue([])

      const res = await makeRequest(app, '/api/policies/scope/acc-nonexistent')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.policies).toEqual([])
    })

    it('passes the correct accountId to the query', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ all: mockAll })
      mockAll.mockReturnValue([])

      await makeRequest(app, '/api/policies/scope/my-account-id-123')
      expect(mockWhere).toHaveBeenCalledOnce()
      const whereArg = mockWhere.mock.calls[0][0]
      expect(whereArg.val).toBe('my-account-id-123')
    })
  })

  describe('PUT /api/policies/scope/:accountId', () => {
    it('upserts scope policies and returns ok', async () => {
      const res = await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [
            { scope: 'gmail.readonly', decision: 'allow' },
            { scope: '*', decision: 'review' },
          ],
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      // Should have inserted twice
      expect(mockInsertValues).toHaveBeenCalledTimes(2)
    })

    it('passes correct data for each policy', async () => {
      await makeRequest(app, '/api/policies/scope/acc-42', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ scope: 'gmail.send', decision: 'block' }],
        }),
      })

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const insertedValues = mockInsertValues.mock.calls[0][0]
      expect(insertedValues.accountId).toBe('acc-42')
      expect(insertedValues.scope).toBe('gmail.send')
      expect(insertedValues.decision).toBe('block')
    })

    it('handles empty policies array', async () => {
      const res = await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: [] }),
      })

      expect(res.status).toBe(200)
      expect(mockInsertValues).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Tool policies (MCP servers)
  // =========================================================================
  describe('GET /api/policies/tool/:mcpId', () => {
    it('returns policies for an MCP server', async () => {
      const mockPolicies = [
        { id: 'p1', mcpId: 'mcp-1', toolName: 'search', decision: 'allow', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ]
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ all: mockAll })
      mockAll.mockReturnValue(mockPolicies)

      const res = await makeRequest(app, '/api/policies/tool/mcp-1')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.policies).toHaveLength(1)
      expect(body.policies[0].toolName).toBe('search')
      expect(body.policies[0].decision).toBe('allow')
    })

    it('returns empty array when no policies exist', async () => {
      mockDbFrom.mockReturnValue({ where: mockWhere })
      mockWhere.mockReturnValue({ all: mockAll })
      mockAll.mockReturnValue([])

      const res = await makeRequest(app, '/api/policies/tool/mcp-nonexistent')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.policies).toEqual([])
    })
  })

  describe('PUT /api/policies/tool/:mcpId', () => {
    it('upserts tool policies and returns ok', async () => {
      const res = await makeRequest(app, '/api/policies/tool/mcp-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [
            { toolName: 'search', decision: 'allow' },
            { toolName: '*', decision: 'block' },
          ],
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(mockInsertValues).toHaveBeenCalledTimes(2)
    })

    it('passes correct data for each tool policy', async () => {
      await makeRequest(app, '/api/policies/tool/mcp-99', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ toolName: 'dangerous_tool', decision: 'block' }],
        }),
      })

      expect(mockInsertValues).toHaveBeenCalledOnce()
      const insertedValues = mockInsertValues.mock.calls[0][0]
      expect(insertedValues.mcpId).toBe('mcp-99')
      expect(insertedValues.toolName).toBe('dangerous_tool')
      expect(insertedValues.decision).toBe('block')
    })
  })

  // =========================================================================
  // Input validation
  // =========================================================================
  describe('PUT /api/policies/scope/:accountId validation', () => {
    it('rejects invalid decision value', async () => {
      const res = await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ scope: 'gmail.readonly', decision: 'yolo' }],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid decision')
    })

    it('rejects empty scope string', async () => {
      const res = await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ scope: '', decision: 'allow' }],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid scope')
    })

    it('rejects missing scope field', async () => {
      const res = await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ decision: 'allow' }],
        }),
      })
      expect(res.status).toBe(400)
    })

    it('rejects non-array policies', async () => {
      const res = await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: 'not an array',
        }),
      })
      expect(res.status).toBe(400)
    })

    it('does not insert any policies when validation fails', async () => {
      await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [
            { scope: 'valid.scope', decision: 'allow' },
            { scope: 'another', decision: 'invalid' },
          ],
        }),
      })
      // Validation happens before any DB operations
      expect(mockInsertValues).not.toHaveBeenCalled()
      expect(mockDeleteWhere).not.toHaveBeenCalled()
    })
  })

  describe('PUT /api/policies/tool/:mcpId validation', () => {
    it('rejects invalid decision value', async () => {
      const res = await makeRequest(app, '/api/policies/tool/mcp-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ toolName: 'search', decision: 'maybe' }],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid decision')
    })

    it('rejects empty toolName', async () => {
      const res = await makeRequest(app, '/api/policies/tool/mcp-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ toolName: '', decision: 'allow' }],
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid toolName')
    })

    it('does not insert any policies when validation fails', async () => {
      await makeRequest(app, '/api/policies/tool/mcp-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ toolName: 'search', decision: 'nope' }],
        }),
      })
      expect(mockInsertValues).not.toHaveBeenCalled()
      expect(mockDeleteWhere).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Transaction atomicity
  // =========================================================================
  describe('PUT uses transaction for atomicity', () => {
    it('scope PUT deletes then inserts within a transaction', async () => {
      const operations: string[] = []
      const mockTransaction = vi.fn((fn: () => void) => {
        operations.push('transaction_start')
        fn()
        operations.push('transaction_end')
      })
      // Override db.transaction for this test
      const { db } = await import('@shared/lib/db')
      const origTransaction = db.transaction
      db.transaction = mockTransaction as typeof db.transaction
      mockDeleteWhere.mockImplementation(() => {
        operations.push('delete')
        return { run: mockDeleteRun }
      })
      mockInsertValues.mockImplementation(() => {
        operations.push('insert')
        return { run: vi.fn() }
      })

      await makeRequest(app, '/api/policies/scope/acc-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policies: [{ scope: 'test', decision: 'allow' }],
        }),
      })

      expect(operations).toEqual([
        'transaction_start',
        'delete',
        'insert',
        'transaction_end',
      ])
      db.transaction = origTransaction
    })
  })
})

// ===========================================================================
// Route reachability test — verifies the policies router is NOT swallowed
// by other routers' wildcard middleware (the actual bug we're preventing)
// ===========================================================================
describe('policies route reachability (integration)', () => {
  it('GET /api/policies/scope/:id is NOT intercepted by agents /:id/* middleware', async () => {
    // Simulate the real app: mount agents (with /:id/* middleware) AND policies
    const mockAgentExists = vi.fn().mockResolvedValue(false)

    const agents = new Hono()
    // This is the middleware that caused the bug — it matches /:id/* and returns 404
    agents.use('/:id/*', async (c, next) => {
      const slug = c.req.param('id')
      if (!(await mockAgentExists(slug))) {
        return c.json({ error: 'Agent not found' }, 404)
      }
      await next()
    })
    agents.get('/:id/status', async (c) => {
      return c.json({ status: 'ok' })
    })

    const policiesRouter = new Hono()
    policiesRouter.get('/scope/:accountId', async (c) => {
      return c.json({ policies: [{ scope: 'test', decision: 'allow' }] })
    })

    const app = new Hono()
    app.route('/api/agents', agents)
    app.route('/api/policies', policiesRouter)

    // This should hit the policies router, NOT the agents middleware
    const res = await app.request('http://localhost/api/policies/scope/acc-123')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.policies).toBeDefined()
    expect(body.error).toBeUndefined()

    // The agents middleware should NOT have been called
    expect(mockAgentExists).not.toHaveBeenCalled()
  })

  it('GET /api/policies/tool/:id is NOT intercepted by agents /:id/* middleware', async () => {
    const mockAgentExists = vi.fn().mockResolvedValue(false)

    const agents = new Hono()
    agents.use('/:id/*', async (c, next) => {
      const slug = c.req.param('id')
      if (!(await mockAgentExists(slug))) {
        return c.json({ error: 'Agent not found' }, 404)
      }
      await next()
    })

    const policiesRouter = new Hono()
    policiesRouter.get('/tool/:mcpId', async (c) => {
      return c.json({ policies: [] })
    })

    const app = new Hono()
    app.route('/api/agents', agents)
    app.route('/api/policies', policiesRouter)

    const res = await app.request('http://localhost/api/policies/tool/mcp-1')
    expect(res.status).toBe(200)
    expect(mockAgentExists).not.toHaveBeenCalled()
  })
})
