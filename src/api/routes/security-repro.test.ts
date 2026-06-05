import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// ---------------------------------------------------------------------------
// Security guardrail repro tests.
//
// These exercise the connected-account reconnect flow in AUTH_MODE and assert
// that a user cannot reconnect (take over) an account owned by another user by
// supplying a `reconnectAccountId` they happen to know. See SUP-198.
//
// The db mock is driven by `selectQueue`: each terminal `.limit()` of a select
// chain shifts the next pre-seeded result. `updateWhereCalls` records every
// `db.update(...).set(...).where(...)` so we can assert no write happened.
// ---------------------------------------------------------------------------

let selectQueue: unknown[][] = []
const updateWhereCalls: unknown[][] = []

const mockDbSelectLimit = vi.fn(() => Promise.resolve(selectQueue.shift() ?? []))
const mockDbUpdateWhere = vi.fn((...args: unknown[]) => {
  updateWhereCalls.push(args)
  return Promise.resolve(undefined)
})
const mockDbInsertValues = vi.fn().mockResolvedValue(undefined)
const mockDbDeleteWhere = vi.fn().mockResolvedValue(undefined)

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelectLimit(),
          orderBy: () => ({ $dynamic: () => ({ where: () => mockDbSelectLimit() }) }),
        }),
        orderBy: () => ({ $dynamic: () => ({ where: () => mockDbSelectLimit() }) }),
      }),
    }),
    insert: () => ({ values: (...vArgs: unknown[]) => mockDbInsertValues(...vArgs) }),
    update: () => ({
      set: () => ({ where: (...wArgs: unknown[]) => mockDbUpdateWhere(...wArgs) }),
    }),
    delete: () => ({ where: (...wArgs: unknown[]) => mockDbDeleteWhere(...wArgs) }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: {
    id: 'id',
    providerConnectionId: 'provider_connection_id',
    providerName: 'provider_name',
    userId: 'user_id',
  },
  agentConnectedAccounts: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  desc: (col: string) => ({ desc: col }),
  and: (...args: unknown[]) => args,
}))

const mockProvider = {
  name: 'composio',
  initiateConnection: vi.fn(),
  getConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getAccountDisplayName: vi.fn(),
}

vi.mock('@shared/lib/account-providers', () => ({
  getDefaultAccountProvider: () => mockProvider,
  getAccountProviderByName: () => mockProvider,
  isValidProviderName: (name: string) => ['composio', 'nango'].includes(name),
  isProviderSupported: () => true,
  getProvider: (slug: string) => ({ slug, displayName: slug.charAt(0).toUpperCase() + slug.slice(1) }),
}))

// Acting (attacker) user. The victim rows seeded into `selectQueue` are owned by
// a different user, so ownership checks must reject the reconnect.
const ACTING_USER_ID = 'attacker-user'

vi.mock('@shared/lib/auth/config', () => ({
  getAppBaseUrlFromRequest: () => 'http://localhost:3000',
  getCurrentUserId: () => ACTING_USER_ID,
}))

vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => true,
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

function appWithConnectedAccounts() {
  const app = new Hono()
  app.route('/api/connected-accounts', connectedAccountsRouter)
  return app
}

function expectClientError(status: number) {
  expect(status).toBeGreaterThanOrEqual(400)
  expect(status).toBeLessThan(500)
}

describe('SUP-198: connected account reconnect ownership (AUTH_MODE)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectQueue = []
    updateWhereCalls.length = 0
    // Defaults so /complete reaches the reconnect branch (active connection).
    mockProvider.getConnection.mockResolvedValue({ id: 'attacker-new-connection', status: 'ACTIVE' })
    mockProvider.getAccountDisplayName.mockResolvedValue('Attacker GitHub')
    mockProvider.deleteConnection.mockResolvedValue(undefined)
  })

  it('rejects initiating reconnect for another user connected account by id', async () => {
    selectQueue = [[{ id: 'victim-account-id', providerConnectionId: 'victim-old-connection', userId: 'victim-user' }]]

    const res = await appWithConnectedAccounts().request('http://localhost/api/connected-accounts/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerSlug: 'github',
        reconnectAccountId: 'victim-account-id',
      }),
    })

    expectClientError(res.status)
    expect(mockProvider.initiateConnection).not.toHaveBeenCalled()
  })

  it('rejects reconnecting another user connected account by id', async () => {
    selectQueue = [[{ providerConnectionId: 'victim-old-connection', userId: 'victim-user' }]]

    const res = await appWithConnectedAccounts().request('http://localhost/api/connected-accounts/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'attacker-new-connection',
        toolkit: 'github',
        providerName: 'composio',
        reconnectAccountId: 'victim-account-id',
      }),
    })

    expectClientError(res.status)
    expect(updateWhereCalls).toEqual([])
  })
})
