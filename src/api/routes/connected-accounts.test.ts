import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const mockDbSelect = vi.fn()
const mockDbSelectFrom = vi.fn()
const mockDbSelectWhere = vi.fn()
const mockDbSelectLimit = vi.fn()
const mockDbInsert = vi.fn()
const mockDbInsertValues = vi.fn()
const mockDbUpdate = vi.fn()
const mockDbUpdateSet = vi.fn()
const mockDbUpdateWhere = vi.fn()
const mockDbDelete = vi.fn()
const mockDbDeleteWhere = vi.fn()

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => {
      mockDbSelect()
      return {
        from: (...args: unknown[]) => {
          mockDbSelectFrom(...args)
          return {
            where: (...wArgs: unknown[]) => {
              mockDbSelectWhere(...wArgs)
              return {
                limit: (...lArgs: unknown[]) => mockDbSelectLimit(...lArgs),
                orderBy: vi.fn().mockReturnValue({ $dynamic: vi.fn().mockReturnValue(mockDbSelectLimit()) }),
              }
            },
            orderBy: vi.fn().mockReturnValue({
              $dynamic: vi.fn().mockReturnValue(mockDbSelectLimit()),
            }),
          }
        },
      }
    },
    insert: (...args: unknown[]) => {
      mockDbInsert(...args)
      return { values: (...vArgs: unknown[]) => { mockDbInsertValues(...vArgs); return { onConflictDoNothing: vi.fn() } } }
    },
    update: (...args: unknown[]) => {
      mockDbUpdate(...args)
      return {
        set: (...sArgs: unknown[]) => {
          mockDbUpdateSet(...sArgs)
          return { where: (...wArgs: unknown[]) => mockDbUpdateWhere(...wArgs) }
        },
      }
    },
    delete: (...args: unknown[]) => {
      mockDbDelete(...args)
      return { where: (...wArgs: unknown[]) => mockDbDeleteWhere(...wArgs) }
    },
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id', providerConnectionId: 'provider_connection_id', providerName: 'provider_name' },
  agentConnectedAccounts: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  desc: (col: string) => ({ desc: col }),
  and: (...args: unknown[]) => args,
}))

const mockInitiateConnection = vi.fn()
const mockGetConnection = vi.fn()
const mockDeleteConnection = vi.fn()
const mockGetAccountDisplayName = vi.fn()
const mockProvider = {
  name: 'composio',
  initiateConnection: (...args: unknown[]) => mockInitiateConnection(...args),
  getConnection: (...args: unknown[]) => mockGetConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  getAccountDisplayName: (...args: unknown[]) => mockGetAccountDisplayName(...args),
}

vi.mock('@shared/lib/account-providers', () => ({
  getDefaultAccountProvider: () => mockProvider,
  getAccountProviderByName: () => mockProvider,
  isValidProviderName: (name: string) => ['composio', 'nango'].includes(name),
  isProviderSupported: () => true,
  getProvider: (slug: string) => ({ slug, displayName: slug.charAt(0).toUpperCase() + slug.slice(1) }),
}))

vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => 'local',
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => false,
}))

vi.mock('@shared/lib/config/settings', () => ({
  getAccountProviderUserId: () => 'test-user',
}))

vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  OwnsAccount: () => async (_c: unknown, next: () => Promise<void>) => next(),
  IsAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  Or: (..._mw: unknown[]) => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: vi.fn(),
}))

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: vi.fn(),
}))

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: vi.fn().mockResolvedValue({}),
}))

import connectedAccountsRouter from './connected-accounts'

function createApp() {
  const app = new Hono()
  app.route('/api/connected-accounts', connectedAccountsRouter)
  return app
}

describe('connected-accounts reconnect flow', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
    mockDbUpdateWhere.mockResolvedValue(undefined)
    mockDbInsertValues.mockResolvedValue(undefined)
    mockDbDeleteWhere.mockResolvedValue(undefined)
    mockDeleteConnection.mockResolvedValue(undefined)
  })

  describe('POST /initiate with reconnectAccountId', () => {
    it('accepts reconnectAccountId and includes it in callback URL', async () => {
      mockDbSelectLimit.mockResolvedValue([{ id: 'existing-acc', providerConnectionId: 'old-conn' }])
      mockInitiateConnection.mockResolvedValue({
        connectionId: 'new-conn',
        redirectUrl: 'https://oauth.example.com/auth',
      })

      const res = await app.request('http://localhost/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerSlug: 'github',
          reconnectAccountId: 'existing-acc',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.redirectUrl).toBe('https://oauth.example.com/auth')

      // Verify the callback URL includes reconnectAccountId
      const callbackUrl = mockInitiateConnection.mock.calls[0][1] as string
      expect(callbackUrl).toContain('reconnectAccountId=existing-acc')
    })

    it('returns 404 if reconnectAccountId does not exist', async () => {
      mockDbSelectLimit.mockResolvedValue([])

      const res = await app.request('http://localhost/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerSlug: 'github',
          reconnectAccountId: 'nonexistent',
        }),
      })

      expect(res.status).toBe(404)
    })
  })

  describe('POST /complete with reconnectAccountId', () => {
    it('updates existing record instead of inserting', async () => {
      mockGetConnection.mockResolvedValue({ id: 'new-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'old-conn' }])

      const res = await app.request('http://localhost/api/connected-accounts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'new-conn',
          toolkit: 'github',
          providerName: 'composio',
          reconnectAccountId: 'existing-acc',
        }),
      })

      expect(res.status).toBe(200)
      // Should update, not insert
      expect(mockDbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
        providerConnectionId: 'new-conn',
        status: 'active',
        displayName: 'My GitHub',
      }))
      expect(mockDbInsertValues).not.toHaveBeenCalled()
    })

    it('deletes old remote connection after reconnect', async () => {
      mockGetConnection.mockResolvedValue({ id: 'new-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'old-conn' }])
      mockDeleteConnection.mockResolvedValue(undefined)

      await app.request('http://localhost/api/connected-accounts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'new-conn',
          toolkit: 'github',
          providerName: 'composio',
          reconnectAccountId: 'existing-acc',
        }),
      })

      // Wait for fire-and-forget delete
      await new Promise((r) => setTimeout(r, 10))
      expect(mockDeleteConnection).toHaveBeenCalledWith('old-conn', 'github')
    })

    it('does not delete old connection if IDs match', async () => {
      mockGetConnection.mockResolvedValue({ id: 'same-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'same-conn' }])

      await app.request('http://localhost/api/connected-accounts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'same-conn',
          toolkit: 'github',
          providerName: 'composio',
          reconnectAccountId: 'existing-acc',
        }),
      })

      await new Promise((r) => setTimeout(r, 10))
      expect(mockDeleteConnection).not.toHaveBeenCalled()
    })

    it('creates new record when no reconnectAccountId', async () => {
      mockGetConnection.mockResolvedValue({ id: 'new-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')

      const res = await app.request('http://localhost/api/connected-accounts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectionId: 'new-conn',
          toolkit: 'github',
          providerName: 'composio',
        }),
      })

      expect(res.status).toBe(200)
      expect(mockDbInsertValues).toHaveBeenCalled()
      expect(mockDbUpdateSet).not.toHaveBeenCalled()
    })
  })
})
