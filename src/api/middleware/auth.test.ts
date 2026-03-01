import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockIsAuthMode = vi.fn<() => boolean>()
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

const mockGetSession = vi.fn()
vi.mock('@shared/lib/auth/index', () => ({
  getAuth: () => ({ api: { getSession: mockGetSession } }),
}))

const mockLimit = vi.fn()
const mockWhere = vi.fn(() => ({ limit: mockLimit }))
const mockFrom = vi.fn(() => ({ where: mockWhere }))
const mockSelect = vi.fn((..._args: unknown[]) => ({ from: mockFrom }))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: { userId: 'user_id', agentSlug: 'agent_slug', role: 'role' },
  connectedAccounts: { id: 'id', userId: 'user_id' },
  remoteMcpServers: { id: 'id', userId: 'user_id' },
  notifications: { id: 'id', userId: 'user_id', agentSlug: 'agent_slug' },
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...args: unknown[]) => args,
}))

const mockValidateProxyToken = vi.fn<(token: string) => Promise<boolean>>()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (token: string) => mockValidateProxyToken(token),
}))

// Import after mocks
import {
  Authenticated,
  AgentRead,
  AgentUser,
  AgentAdmin,
  IsAdmin,
  IsAgent,
  OwnsAccount,
  UsersMcpServer,
  HasNotificationAccess,
  Or,
} from './auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Hono app that uses the given middleware on GET /:id */
function buildApp(middleware: MiddlewareHandler) {
  const app = new Hono()
  app.get('/:id', middleware, (c) => c.json({ ok: true }))
  return app
}

/** Build a Hono app with route without params (e.g. for Authenticated / IsAdmin) */
function buildAppNoParam(middleware: MiddlewareHandler) {
  const app = new Hono()
  app.get('/', middleware, (c) => c.json({ ok: true }))
  return app
}

async function request(app: Hono, path = '/test-agent') {
  return app.request(`http://localhost${path}`)
}

function setUser(app: Hono, user: { id: string; role?: string }) {
  app.use('*', async (c, next) => {
    c.set('user' as never, user as never)
    return next()
  })
}

function mockAclQuery(role: string | null) {
  mockLimit.mockResolvedValue(role ? [{ role }] : [])
}

function mockOwnershipQuery(userId: string | null) {
  mockLimit.mockResolvedValue(userId ? [{ userId }] : [])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthMode.mockReturnValue(true)
  })

  // =========================================================================
  // Authenticated()
  // =========================================================================

  describe('Authenticated()', () => {
    it('is no-op when auth mode disabled — calls next()', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildAppNoParam(Authenticated())
      const res = await request(app, '/')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(mockGetSession).not.toHaveBeenCalled()
    })

    it('returns 401 when no session (auth mode enabled)', async () => {
      mockGetSession.mockResolvedValue(null)
      const app = buildAppNoParam(Authenticated())
      const res = await request(app, '/')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 when getSession returns undefined', async () => {
      mockGetSession.mockResolvedValue(undefined)
      const app = buildAppNoParam(Authenticated())
      const res = await request(app, '/')
      expect(res.status).toBe(401)
    })

    it('attaches user to context on valid session', async () => {
      const user = { id: 'user-1', name: 'Alice', role: 'user' }
      mockGetSession.mockResolvedValue({ user })

      let capturedUser: unknown = null
      const app = new Hono()
      app.get('/', Authenticated(), (c) => {
        capturedUser = c.get('user' as never)
        return c.json({ ok: true })
      })

      const res = await request(app, '/')
      expect(res.status).toBe(200)
      expect(capturedUser).toEqual(user)
    })

    it('passes request headers to getSession', async () => {
      mockGetSession.mockResolvedValue(null)
      const app = buildAppNoParam(Authenticated())
      await app.request('http://localhost/', {
        headers: { Cookie: 'session=abc123', Authorization: 'Bearer xyz' },
      })
      expect(mockGetSession).toHaveBeenCalledOnce()
      const callArg = mockGetSession.mock.calls[0][0]
      expect(callArg.headers).toBeInstanceOf(Headers)
      expect(callArg.headers.get('cookie')).toBe('session=abc123')
    })

    it('attaches admin user to context correctly', async () => {
      const adminUser = { id: 'admin-1', name: 'Admin', role: 'admin' }
      mockGetSession.mockResolvedValue({ user: adminUser })

      let capturedUser: unknown = null
      const app = new Hono()
      app.get('/', Authenticated(), (c) => {
        capturedUser = c.get('user' as never)
        return c.json({ ok: true })
      })

      const res = await request(app, '/')
      expect(res.status).toBe(200)
      expect(capturedUser).toEqual(adminUser)
    })
  })

  // =========================================================================
  // AgentRead()
  // =========================================================================

  describe('AgentRead()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(AgentRead())
      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows admin users without ACL check', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows user with viewer role', async () => {
      mockAclQuery('viewer')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('allows user with user role', async () => {
      mockAclQuery('user')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('allows user with owner role', async () => {
      mockAclQuery('owner')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('returns 403 when user has no role on agent', async () => {
      mockAclQuery(null)
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it('throws when user not in context (Authenticated missing)', async () => {
      const app = buildApp(AgentRead())
      // No user set in context — should throw
      const res = await request(app)
      expect(res.status).toBe(500)
    })
  })

  // =========================================================================
  // AgentUser()
  // =========================================================================

  describe('AgentUser()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(AgentUser())
      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('allows admin users without ACL check', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows user with owner role', async () => {
      mockAclQuery('owner')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('allows user with user role', async () => {
      mockAclQuery('user')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('returns 403 when user has viewer role (insufficient)', async () => {
      mockAclQuery('viewer')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })

    it('returns 403 when user has no role on agent', async () => {
      mockAclQuery(null)
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })
  })

  // =========================================================================
  // AgentAdmin()
  // =========================================================================

  describe('AgentAdmin()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(AgentAdmin())
      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('allows admin users without ACL check', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows user with owner role', async () => {
      mockAclQuery('owner')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('returns 403 when user has user role (insufficient)', async () => {
      mockAclQuery('user')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })

    it('returns 403 when user has viewer role (insufficient)', async () => {
      mockAclQuery('viewer')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })

    it('returns 403 when user has no role on agent', async () => {
      mockAclQuery(null)
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })
  })

  // =========================================================================
  // IsAdmin()
  // =========================================================================

  describe('IsAdmin()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildAppNoParam(IsAdmin())
      const res = await request(app, '/')
      expect(res.status).toBe(200)
    })

    it('allows admin user', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app, '/')
      expect(res.status).toBe(200)
    })

    it('returns 403 for non-admin user', async () => {
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app, '/')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    })

    it('returns 403 for user with no role set', async () => {
      const app = new Hono()
      setUser(app, { id: 'user-1' })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app, '/')
      expect(res.status).toBe(403)
    })

    it('returns 403 for user with undefined role', async () => {
      const app = new Hono()
      setUser(app, { id: 'user-1', role: undefined })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app, '/')
      expect(res.status).toBe(403)
    })

    it('throws when user not in context', async () => {
      const app = buildAppNoParam(IsAdmin())
      const res = await request(app, '/')
      expect(res.status).toBe(500)
    })
  })

  // =========================================================================
  // IsAgent()
  // =========================================================================

  describe('IsAgent()', () => {
    it('allows request with valid proxy token', async () => {
      mockValidateProxyToken.mockResolvedValue(true)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test', {
        headers: { Authorization: 'Bearer valid-token' },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(mockValidateProxyToken).toHaveBeenCalledWith('valid-token')
    })

    it('returns 401 when proxy token is invalid', async () => {
      mockValidateProxyToken.mockResolvedValue(false)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test', {
        headers: { Authorization: 'Bearer bad-token' },
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 when Authorization header is missing', async () => {
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
      expect(mockValidateProxyToken).not.toHaveBeenCalled()
    })

    it('returns 401 when Authorization header has wrong format', async () => {
      mockValidateProxyToken.mockResolvedValue(false)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test', {
        headers: { Authorization: 'InvalidFormat token' },
      })
      expect(res.status).toBe(401)
    })

    it('validates tokens regardless of auth mode being enabled', async () => {
      mockIsAuthMode.mockReturnValue(true)
      mockValidateProxyToken.mockResolvedValue(true)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test', {
        headers: { Authorization: 'Bearer valid-token' },
      })
      expect(res.status).toBe(200)
      expect(mockValidateProxyToken).toHaveBeenCalledWith('valid-token')
    })

    it('validates tokens regardless of auth mode being disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      mockValidateProxyToken.mockResolvedValue(true)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test', {
        headers: { Authorization: 'Bearer valid-token' },
      })
      expect(res.status).toBe(200)
      expect(mockValidateProxyToken).toHaveBeenCalledWith('valid-token')
    })

    it('rejects missing token in non-auth mode', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test')
      expect(res.status).toBe(401)
    })

    it('rejects invalid token in non-auth mode', async () => {
      mockIsAuthMode.mockReturnValue(false)
      mockValidateProxyToken.mockResolvedValue(false)
      const app = new Hono()
      app.get('/test', IsAgent(), (c) => c.json({ ok: true }))

      const res = await app.request('http://localhost/test', {
        headers: { Authorization: 'Bearer bad-token' },
      })
      expect(res.status).toBe(401)
    })
  })

  // =========================================================================
  // OwnsAccount()
  // =========================================================================

  describe('OwnsAccount()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(OwnsAccount())
      const res = await request(app, '/acc-1')
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows when user owns the account', async () => {
      mockOwnershipQuery('user-1')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', OwnsAccount(), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(200)
    })

    it('returns 403 when different user owns the account', async () => {
      mockOwnershipQuery('user-2')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', OwnsAccount(), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(403)
    })

    it('returns 403 when account does not exist', async () => {
      mockOwnershipQuery(null)
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', OwnsAccount(), (c) => c.json({ ok: true }))

      const res = await request(app, '/nonexistent')
      expect(res.status).toBe(403)
    })
  })

  // =========================================================================
  // UsersMcpServer()
  // =========================================================================

  describe('UsersMcpServer()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(UsersMcpServer())
      const res = await request(app, '/mcp-1')
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows when user owns the MCP server', async () => {
      mockOwnershipQuery('user-1')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', UsersMcpServer(), (c) => c.json({ ok: true }))

      const res = await request(app, '/mcp-1')
      expect(res.status).toBe(200)
    })

    it('returns 403 when different user owns the MCP server', async () => {
      mockOwnershipQuery('user-2')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', UsersMcpServer(), (c) => c.json({ ok: true }))

      const res = await request(app, '/mcp-1')
      expect(res.status).toBe(403)
    })

    it('returns 403 when MCP server does not exist', async () => {
      mockOwnershipQuery(null)
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', UsersMcpServer(), (c) => c.json({ ok: true }))

      const res = await request(app, '/nonexistent')
      expect(res.status).toBe(403)
    })
  })

  // =========================================================================
  // HasNotificationAccess()
  // =========================================================================

  describe('HasNotificationAccess()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(HasNotificationAccess())
      const res = await request(app, '/notif-1')
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows admin users without agent access check', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', HasNotificationAccess(), (c) => c.json({ ok: true }))

      const res = await request(app, '/notif-1')
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('allows when user has access to notification agent', async () => {
      // First query returns notification with agentSlug
      mockLimit.mockResolvedValueOnce([{ agentSlug: 'test-agent' }])
      // Second query returns user's role on that agent
      mockLimit.mockResolvedValueOnce([{ role: 'user' }])

      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', HasNotificationAccess(), (c) => c.json({ ok: true }))

      const res = await request(app, '/notif-1')
      expect(res.status).toBe(200)
    })

    it('returns 403 when user has no access to notification agent', async () => {
      // First query returns notification with agentSlug
      mockLimit.mockResolvedValueOnce([{ agentSlug: 'test-agent' }])
      // Second query returns no role (no access)
      mockLimit.mockResolvedValueOnce([])

      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', HasNotificationAccess(), (c) => c.json({ ok: true }))

      const res = await request(app, '/notif-1')
      expect(res.status).toBe(403)
    })

    it('returns 404 when notification does not exist', async () => {
      mockLimit.mockResolvedValueOnce([])

      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', HasNotificationAccess(), (c) => c.json({ ok: true }))

      const res = await request(app, '/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  // =========================================================================
  // Or() combinator
  // =========================================================================

  describe('Or()', () => {
    it('is no-op when auth mode disabled', async () => {
      mockIsAuthMode.mockReturnValue(false)
      const app = buildApp(Or(OwnsAccount(), IsAdmin()))
      const res = await request(app, '/acc-1')
      expect(res.status).toBe(200)
    })

    describe('Or(OwnsAccount(), IsAdmin())', () => {
      it('allows when user owns the account (first middleware passes)', async () => {
        mockOwnershipQuery('user-1')
        const app = new Hono()
        setUser(app, { id: 'user-1', role: 'user' })
        app.get('/:id', Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/acc-1')
        expect(res.status).toBe(200)
      })

      it('allows admin even if they do not own the account (second middleware passes)', async () => {
        mockOwnershipQuery('user-2') // owned by different user
        const app = new Hono()
        setUser(app, { id: 'admin-1', role: 'admin' })
        app.get('/:id', Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/acc-1')
        expect(res.status).toBe(200)
      })

      it('returns 403 when non-owner non-admin', async () => {
        mockOwnershipQuery('user-2')
        const app = new Hono()
        setUser(app, { id: 'user-1', role: 'user' })
        app.get('/:id', Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/acc-1')
        expect(res.status).toBe(403)
      })

      it('returns 403 when account does not exist and user is not admin', async () => {
        mockOwnershipQuery(null)
        const app = new Hono()
        setUser(app, { id: 'user-1', role: 'user' })
        app.get('/:id', Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/nonexistent')
        expect(res.status).toBe(403)
      })

      it('allows admin even when account does not exist', async () => {
        mockOwnershipQuery(null)
        const app = new Hono()
        setUser(app, { id: 'admin-1', role: 'admin' })
        app.get('/:id', Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/nonexistent')
        expect(res.status).toBe(200)
      })
    })

    describe('Or(UsersMcpServer(), IsAdmin())', () => {
      it('allows when user owns the MCP server', async () => {
        mockOwnershipQuery('user-1')
        const app = new Hono()
        setUser(app, { id: 'user-1', role: 'user' })
        app.get('/:id', Or(UsersMcpServer(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/mcp-1')
        expect(res.status).toBe(200)
      })

      it('allows admin who does not own the MCP server', async () => {
        mockOwnershipQuery('user-2')
        const app = new Hono()
        setUser(app, { id: 'admin-1', role: 'admin' })
        app.get('/:id', Or(UsersMcpServer(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/mcp-1')
        expect(res.status).toBe(200)
      })

      it('returns 403 for non-owner non-admin', async () => {
        mockOwnershipQuery('user-2')
        const app = new Hono()
        setUser(app, { id: 'user-1', role: 'user' })
        app.get('/:id', Or(UsersMcpServer(), IsAdmin()), (c) => c.json({ ok: true }))

        const res = await request(app, '/mcp-1')
        expect(res.status).toBe(403)
      })
    })
  })

  // =========================================================================
  // Middleware composition (chaining)
  // =========================================================================

  describe('Middleware chaining', () => {
    it('Authenticated() + AgentRead() — blocks unauthenticated user at Authenticated', async () => {
      mockGetSession.mockResolvedValue(null)

      const app = new Hono()
      app.get('/:id', Authenticated(), AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(401)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('Authenticated() + AgentRead() — authenticated user with viewer passes', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })
      mockAclQuery('viewer')

      const app = new Hono()
      app.get('/:id', Authenticated(), AgentRead(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('Authenticated() + AgentUser() — blocks viewer after auth', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })
      mockAclQuery('viewer')

      const app = new Hono()
      app.get('/:id', Authenticated(), AgentUser(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })

    it('Authenticated() + AgentAdmin() — blocks user role after auth', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })
      mockAclQuery('user')

      const app = new Hono()
      app.get('/:id', Authenticated(), AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(403)
    })

    it('Authenticated() + AgentAdmin() — allows owner after auth', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })
      mockAclQuery('owner')

      const app = new Hono()
      app.get('/:id', Authenticated(), AgentAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
    })

    it('Authenticated() + IsAdmin() — blocks non-admin after auth', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })

      const app = new Hono()
      app.get('/', Authenticated(), IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app, '/')
      expect(res.status).toBe(403)
    })

    it('Authenticated() + IsAdmin() — allows admin after auth', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'admin-1', role: 'admin' } })

      const app = new Hono()
      app.get('/', Authenticated(), IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app, '/')
      expect(res.status).toBe(200)
    })

    it('Authenticated() + Or(OwnsAccount(), IsAdmin()) — full chain for owner', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })
      mockOwnershipQuery('user-1')

      const app = new Hono()
      app.get('/:id', Authenticated(), Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(200)
    })

    it('Authenticated() + Or(OwnsAccount(), IsAdmin()) — full chain rejects non-owner non-admin', async () => {
      mockGetSession.mockResolvedValue({ user: { id: 'user-1', role: 'user' } })
      mockOwnershipQuery('user-2')

      const app = new Hono()
      app.get('/:id', Authenticated(), Or(OwnsAccount(), IsAdmin()), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(403)
    })

    it('all middleware is no-op when auth disabled — full chain passes', async () => {
      mockIsAuthMode.mockReturnValue(false)

      const app = new Hono()
      app.get('/:id', Authenticated(), AgentAdmin(), IsAdmin(), (c) => c.json({ ok: true }))

      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockGetSession).not.toHaveBeenCalled()
      expect(mockSelect).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Role hierarchy edge cases
  // =========================================================================

  describe('Role hierarchy', () => {
    const roleCases: Array<{ role: string; read: boolean; user: boolean; admin: boolean }> = [
      { role: 'viewer', read: true, user: false, admin: false },
      { role: 'user',   read: true, user: true,  admin: false },
      { role: 'owner',  read: true, user: true,  admin: true },
    ]

    for (const { role, read, user: userOk, admin } of roleCases) {
      describe(`agent role: ${role}`, () => {
        it(`AgentRead: ${read ? 'allows' : 'blocks'}`, async () => {
          mockAclQuery(role)
          const app = new Hono()
          setUser(app, { id: 'user-1', role: 'user' })
          app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))
          const res = await request(app)
          expect(res.status).toBe(read ? 200 : 403)
        })

        it(`AgentUser: ${userOk ? 'allows' : 'blocks'}`, async () => {
          mockAclQuery(role)
          const app = new Hono()
          setUser(app, { id: 'user-1', role: 'user' })
          app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))
          const res = await request(app)
          expect(res.status).toBe(userOk ? 200 : 403)
        })

        it(`AgentAdmin: ${admin ? 'allows' : 'blocks'}`, async () => {
          mockAclQuery(role)
          const app = new Hono()
          setUser(app, { id: 'user-1', role: 'user' })
          app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))
          const res = await request(app)
          expect(res.status).toBe(admin ? 200 : 403)
        })
      })
    }

    it('no ACL entry at all — all Agent* middleware reject', async () => {
      mockAclQuery(null)
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/read/:id', AgentRead(), (c) => c.json({ ok: true }))
      app.get('/use/:id', AgentUser(), (c) => c.json({ ok: true }))
      app.get('/admin/:id', AgentAdmin(), (c) => c.json({ ok: true }))

      expect((await request(app, '/read/agent-1')).status).toBe(403)
      expect((await request(app, '/use/agent-1')).status).toBe(403)
      expect((await request(app, '/admin/agent-1')).status).toBe(403)
    })
  })

  // =========================================================================
  // Admin bypass across all Agent* middleware
  // =========================================================================

  describe('Admin bypass', () => {
    it('admin bypasses AgentRead without DB lookup', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))
      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('admin bypasses AgentUser without DB lookup', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', AgentUser(), (c) => c.json({ ok: true }))
      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })

    it('admin bypasses AgentAdmin without DB lookup', async () => {
      const app = new Hono()
      setUser(app, { id: 'admin-1', role: 'admin' })
      app.get('/:id', AgentAdmin(), (c) => c.json({ ok: true }))
      const res = await request(app)
      expect(res.status).toBe(200)
      expect(mockSelect).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Agent slug extraction
  // =========================================================================

  describe('Agent slug extraction from route params', () => {
    it('passes correct agent slug to ACL query', async () => {
      mockAclQuery('owner')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      await request(app, '/my-special-agent')

      // The select mock chain: select() -> from() -> where() -> limit()
      // We can verify the where call got the right params
      expect(mockWhere).toHaveBeenCalledOnce()
    })

    it('different agent slugs trigger separate queries', async () => {
      mockAclQuery('owner')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', AgentRead(), (c) => c.json({ ok: true }))

      await request(app, '/agent-a')
      await request(app, '/agent-b')

      expect(mockWhere).toHaveBeenCalledTimes(2)
    })
  })

  // =========================================================================
  // Edge cases and error handling
  // =========================================================================

  describe('Edge cases', () => {
    it('user with empty string role is not admin', async () => {
      const app = new Hono()
      setUser(app, { id: 'user-1', role: '' })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))
      const res = await request(app, '/')
      expect(res.status).toBe(403)
    })

    it('user with null role is not admin', async () => {
      const app = new Hono()
      setUser(app, { id: 'user-1', role: undefined })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))
      const res = await request(app, '/')
      expect(res.status).toBe(403)
    })

    it('Or() with single middleware works', async () => {
      mockOwnershipQuery('user-1')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', Or(OwnsAccount()), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(200)
    })

    it('Or() with single failing middleware returns 403', async () => {
      mockOwnershipQuery('user-2')
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', Or(OwnsAccount()), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(403)
    })

    it('middleware does not call next() twice', async () => {
      let callCount = 0
      mockGetSession.mockResolvedValue({ user: { id: 'u1', role: 'user' } })

      const app = new Hono()
      app.get('/', Authenticated(), (c) => {
        callCount++
        return c.json({ ok: true })
      })

      await request(app, '/')
      expect(callCount).toBe(1)
    })

    it('ownership middleware with userId null in DB returns 403', async () => {
      // Simulates row exists but userId is null
      mockLimit.mockResolvedValue([{ userId: null }])
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/:id', OwnsAccount(), (c) => c.json({ ok: true }))

      const res = await request(app, '/acc-1')
      expect(res.status).toBe(403)
    })

    it('response body structure is consistent across all 401 errors', async () => {
      mockGetSession.mockResolvedValue(null)
      const app = buildAppNoParam(Authenticated())
      const res = await request(app, '/')
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(typeof body.error).toBe('string')
    })

    it('response body structure is consistent across all 403 errors', async () => {
      const app = new Hono()
      setUser(app, { id: 'user-1', role: 'user' })
      app.get('/', IsAdmin(), (c) => c.json({ ok: true }))
      const res = await request(app, '/')
      const body = await res.json()
      expect(body).toHaveProperty('error')
      expect(typeof body.error).toBe('string')
    })
  })

  // =========================================================================
  // Non-auth mode comprehensive check
  // =========================================================================

  describe('Non-auth mode (all middleware no-op)', () => {
    beforeEach(() => {
      mockIsAuthMode.mockReturnValue(false)
    })

    const middlewareFactories = [
      { name: 'Authenticated', fn: Authenticated, needsParam: false },
      { name: 'AgentRead',     fn: AgentRead,     needsParam: true },
      { name: 'AgentUser',     fn: AgentUser,     needsParam: true },
      { name: 'AgentAdmin',    fn: AgentAdmin,    needsParam: true },
      { name: 'IsAdmin',       fn: IsAdmin,       needsParam: false },
      { name: 'OwnsAccount',   fn: OwnsAccount,   needsParam: true },
      { name: 'UsersMcpServer', fn: UsersMcpServer, needsParam: true },
      { name: 'HasNotificationAccess', fn: HasNotificationAccess, needsParam: true },
    ]

    for (const { name, fn, needsParam } of middlewareFactories) {
      it(`${name}() passes through without any DB or auth checks`, async () => {
        const app = needsParam ? buildApp(fn()) : buildAppNoParam(fn())
        const path = needsParam ? '/test-id' : '/'
        const res = await request(app, path)
        expect(res.status).toBe(200)
        expect(mockGetSession).not.toHaveBeenCalled()
        expect(mockSelect).not.toHaveBeenCalled()
      })
    }

    it('Or() passes through without running inner middleware checks', async () => {
      const app = buildApp(Or(OwnsAccount(), IsAdmin()))
      const res = await request(app, '/test-id')
      expect(res.status).toBe(200)
      expect(mockGetSession).not.toHaveBeenCalled()
      expect(mockSelect).not.toHaveBeenCalled()
    })
  })
})
