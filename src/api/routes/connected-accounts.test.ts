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
  connectedAccounts: { id: 'id', providerConnectionId: 'provider_connection_id', providerName: 'provider_name', toolkitSlug: 'toolkit_slug', displayName: 'display_name', userId: 'user_id' },
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

vi.mock('@shared/lib/account-providers', async () => {
  const catalog = await vi.importActual<typeof import('@shared/lib/account-providers/service-catalog')>('@shared/lib/account-providers/service-catalog')
  return {
    getDefaultAccountProvider: () => mockProvider,
    getAccountProviderByName: () => mockProvider,
    isValidProviderName: (name: string) => ['composio', 'nango'].includes(name),
    isProviderSupported: () => true,
    // Shopify keeps its real adapter; other slugs are stubs.
    getProvider: (slug: string) => slug === 'shopify'
      ? catalog.getProvider(slug)
      : ({ slug, displayName: slug.charAt(0).toUpperCase() + slug.slice(1) }),
  }
})

// The Shopify adapter starts its grant and reads the finished grant's store from Composio.
const mockComposioFetch = vi.fn()
vi.mock('@shared/lib/composio/client', () => ({
  composioFetch: (...args: unknown[]) => mockComposioFetch(...args),
  getOrCreateAuthConfig: async () => ({ id: 'ac_shopify' }),
}))

/** The Shopify grant Composio reports: `subdomain` is the store it authorized. */
function composioGrant(subdomain?: string) {
  mockComposioFetch.mockResolvedValue({ toolkit: { slug: 'shopify' }, state: { val: subdomain ? { subdomain } : {} } })
}

/** The body of the Shopify adapter's `POST /connected_accounts`. */
function createdConnection() {
  const [endpoint, init] = mockComposioFetch.mock.calls[0]
  expect(endpoint).toBe('/connected_accounts')
  return JSON.parse((init as RequestInit).body as string).connection
}

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

const mockLogAuditEvent = vi.fn()

vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}))

const mockCountActiveTriggersPerAccount = vi.fn()
const mockCancelTriggersForConnectedAccount = vi.fn()
const mockFindAgentsAssignedConnectedAccount = vi.fn()
  .mockResolvedValue(['agent-a'])
const mockSyncAgentsAssignedConnectedAccount = vi.fn().mockResolvedValue(true)
const mockSyncConnectedAccountAgents = vi.fn().mockResolvedValue(true)
const mockCompleteReauthAccount = vi.fn()

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  countActiveTriggersPerAccount: (...args: unknown[]) => mockCountActiveTriggersPerAccount(...args),
  cancelTriggersForConnectedAccount: (...args: unknown[]) => mockCancelTriggersForConnectedAccount(...args),
}))

vi.mock('@shared/lib/services/connection-sync-service', () => ({
  findAgentsAssignedConnectedAccount: (...args: unknown[]) =>
    mockFindAgentsAssignedConnectedAccount(...args),
  syncAgentsAssignedConnectedAccount: (...args: unknown[]) =>
    mockSyncAgentsAssignedConnectedAccount(...args),
  syncConnectedAccountAgents: (...args: unknown[]) =>
    mockSyncConnectedAccountAgents(...args),
}))

vi.mock('@shared/lib/proxy/account-reauth-manager', () => ({
  accountReauthManager: {
    completeAccount: (...args: unknown[]) => mockCompleteReauthAccount(...args),
  },
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
    mockCancelTriggersForConnectedAccount.mockResolvedValue(undefined)
    mockCountActiveTriggersPerAccount.mockResolvedValue({})
  })

  describe('POST /initiate with reconnectAccountId', () => {
    it('accepts reconnectAccountId and includes it in callback URL', async () => {
      mockDbSelectLimit.mockResolvedValue([{ id: 'existing-acc', providerConnectionId: 'old-conn', toolkitSlug: 'github' }])
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

  describe('Shopify', () => {
    const SHOP = 'gamut-dev.myshopify.com'

    // Installs start at the App Store listing, which the renderer opens itself:
    // a connect without a real store never reaches Composio.
    it.each([
      ['no store', undefined],
      ['a store outside myshopify.com', 'evil.com'],
    ])('refuses a connect with %s', async (_, shop) => {
      const res = await app.request('http://localhost/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerSlug: 'shopify', identity: shop }),
      })

      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/App Store/)
      expect(mockComposioFetch).not.toHaveBeenCalled()
    })

    // Composio's link page would ask the merchant to type the store. A lapsed
    // store account is granted again, not opened.
    it.each([
      ['a new store', []],
      ['a lapsed store', [{ id: 'shop-acc', displayName: SHOP, status: 'expired' }]],
    ])('starts the grant with the store pre-filled for %s', async (_, existing) => {
      mockDbSelectLimit.mockResolvedValue(existing)
      mockComposioFetch.mockResolvedValue({ id: 'ca_shop', redirect_url: 'https://backend.composio.dev/s/abc' })

      const res = await app.request('http://localhost/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerSlug: 'shopify', identity: SHOP }),
      })

      expect(await res.json()).toMatchObject({ connectionId: 'ca_shop', redirectUrl: 'https://backend.composio.dev/s/abc' })
      expect(createdConnection().state.val.subdomain).toBe('gamut-dev')
      expect(mockInitiateConnection).not.toHaveBeenCalled()
    })

    // A second Composio grant for a store retires the first connection's refresh
    // token, and Shopify reopens the install on every admin visit.
    it('returns the connected account for a store instead of a second grant', async () => {
      mockDbSelectLimit.mockResolvedValue([{ id: 'shop-acc', displayName: SHOP, status: 'active' }])

      const res = await app.request('http://localhost/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerSlug: 'shopify', identity: SHOP }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ accountId: 'shop-acc' })
      expect(mockComposioFetch).not.toHaveBeenCalled()
    })

    it('reconnects an existing account through its store', async () => {
      mockDbSelectLimit.mockResolvedValue([{ id: 'shop-acc', providerConnectionId: 'old', displayName: SHOP, toolkitSlug: 'shopify', status: 'active' }])
      mockComposioFetch.mockResolvedValue({ id: 'ca_new', redirect_url: 'https://backend.composio.dev/s/def' })

      const res = await app.request('http://localhost/api/connected-accounts/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerSlug: 'shopify', reconnectAccountId: 'shop-acc' }),
      })

      expect(await res.json()).toMatchObject({ redirectUrl: 'https://backend.composio.dev/s/def' })
      const connection = createdConnection()
      expect(connection.state.val.subdomain).toBe('gamut-dev')
      expect(connection.callback_url).toContain('reconnectAccountId=shop-acc')
    })

    it('names the new account after its store', async () => {
      mockDbSelectLimit.mockResolvedValue([])
      mockGetConnection.mockResolvedValue({ id: 'ca_shop', status: 'ACTIVE' })
      composioGrant('gamut-dev')

      const res = await app.request(
        'http://localhost/api/connected-accounts/callback' +
        '?connectedAccountId=ca_shop&status=success&toolkit=shopify',
      )

      expect(res.status).toBe(200)
      expect(mockDbInsertValues.mock.calls[0][0]).toMatchObject({ toolkitSlug: 'shopify', displayName: SHOP })
    })

    // Composio has already granted the authorized store, so the account for THAT
    // store takes the connection, not the one the reconnect started from.
    it('saves a reconnect under the store that was authorized', async () => {
      mockGetConnection.mockResolvedValue({ id: 'ca_other', status: 'ACTIVE' })
      composioGrant('other-store')
      mockDbSelectLimit.mockResolvedValue([{ id: 'other-acc', providerConnectionId: 'ca_first', displayName: 'other-store.myshopify.com', toolkitSlug: 'shopify' }])

      const res = await app.request('http://localhost/api/connected-accounts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: 'ca_other', toolkit: 'shopify', reconnectAccountId: 'shop-acc' }),
      })

      expect(res.status).toBe(200)
      expect(mockDbUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ providerConnectionId: 'ca_other', displayName: 'other-store.myshopify.com' }))
      expect(mockDbSelectWhere).toHaveBeenCalledWith([
        { col: 'toolkit_slug', val: 'shopify' },
        { col: 'display_name', val: 'other-store.myshopify.com' },
        undefined,
      ])
      expect(mockDbUpdateWhere).toHaveBeenCalledWith({ col: 'id', val: 'other-acc' })
      expect(mockCompleteReauthAccount).toHaveBeenCalledWith('other-acc')
    })

    it('does not save a Shopify account whose store could not be verified', async () => {
      mockGetConnection.mockResolvedValue({ id: 'ca_shop', status: 'ACTIVE' })
      composioGrant()

      const res = await app.request('http://localhost/api/connected-accounts/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: 'ca_shop', toolkit: 'shopify' }),
      })

      expect(res.status).toBe(502)
      expect(mockDbInsertValues).not.toHaveBeenCalled()
      expect(mockDbUpdateSet).not.toHaveBeenCalled()
    })

    it('refuses to rename a Shopify account', async () => {
      mockDbSelectLimit.mockResolvedValue([{ id: 'shop-acc', toolkitSlug: 'shopify', displayName: SHOP }])

      const res = await app.request('http://localhost/api/connected-accounts/shop-acc', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'My store' }),
      })

      expect(res.status).toBe(400)
      expect(mockDbUpdateSet).not.toHaveBeenCalled()
    })
  })

  describe('POST /complete with reconnectAccountId', () => {
    it('updates existing record instead of inserting', async () => {
      mockGetConnection.mockResolvedValue({ id: 'new-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'old-conn', toolkitSlug: 'github' }])

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
      expect(await res.json()).toMatchObject({ liveRefresh: true })
      expect(mockSyncAgentsAssignedConnectedAccount).toHaveBeenCalledWith(
        'existing-acc',
      )
      expect(mockCompleteReauthAccount).toHaveBeenCalledWith('existing-acc')
    })

    it('deletes old remote connection after reconnect', async () => {
      mockGetConnection.mockResolvedValue({ id: 'new-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'old-conn', toolkitSlug: 'github' }])
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
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'same-conn', toolkitSlug: 'github' }])

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
      expect(mockSyncAgentsAssignedConnectedAccount).toHaveBeenCalledWith(
        expect.any(String),
      )
      expect(mockCompleteReauthAccount).not.toHaveBeenCalled()
    })
  })

  describe('GET /callback with reconnectAccountId', () => {
    it('resumes parked proxy requests after the web OAuth callback activates the account', async () => {
      mockGetConnection.mockResolvedValue({ id: 'new-web-conn', status: 'ACTIVE' })
      mockGetAccountDisplayName.mockResolvedValue('My GitHub')
      mockDbSelectLimit.mockResolvedValue([{ providerConnectionId: 'old-conn', toolkitSlug: 'github' }])

      const res = await app.request(
        'http://localhost/api/connected-accounts/callback' +
        '?connectedAccountId=new-web-conn&status=success&toolkit=github' +
        '&reconnectAccountId=existing-acc',
      )

      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Connected Successfully!')
      expect(mockCompleteReauthAccount).toHaveBeenCalledWith('existing-acc')
    })
  })

  describe('DELETE /:id', () => {
    it('cancels webhook triggers before deleting the provider connection and account row', async () => {
      mockDbSelectLimit.mockResolvedValue([{
        id: 'existing-acc',
        providerConnectionId: 'remote-conn',
        providerName: 'composio',
        toolkitSlug: 'github',
      }])

      const res = await app.request('http://localhost/api/connected-accounts/existing-acc', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, liveRefresh: true })
      expect(mockCancelTriggersForConnectedAccount).toHaveBeenCalledWith('existing-acc')
      expect(mockDeleteConnection).toHaveBeenCalledWith('remote-conn', 'github')
      expect(mockDbDeleteWhere).toHaveBeenCalledWith({ col: 'id', val: 'existing-acc' })
      expect(mockLogAuditEvent).toHaveBeenCalledWith({
        userId: 'local',
        object: 'account',
        objectId: 'existing-acc',
        action: 'disconnected',
        details: { toolkitSlug: 'github' },
      })

      expect(mockCancelTriggersForConnectedAccount.mock.invocationCallOrder[0])
        .toBeLessThan(mockDeleteConnection.mock.invocationCallOrder[0])
      expect(mockDeleteConnection.mock.invocationCallOrder[0])
        .toBeLessThan(mockDbDeleteWhere.mock.invocationCallOrder[0])
      expect(mockFindAgentsAssignedConnectedAccount).toHaveBeenCalledWith(
        'existing-acc',
      )
      expect(mockSyncConnectedAccountAgents).toHaveBeenCalledWith(['agent-a'])
    })

    it('still deletes the local row when remote provider cleanup fails', async () => {
      mockDbSelectLimit.mockResolvedValue([{
        id: 'existing-acc',
        providerConnectionId: 'remote-conn',
        providerName: 'composio',
        toolkitSlug: 'github',
      }])
      mockDeleteConnection.mockRejectedValue(new Error('remote unavailable'))

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const res = await app.request('http://localhost/api/connected-accounts/existing-acc', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ success: true, liveRefresh: true })
      expect(mockCancelTriggersForConnectedAccount).toHaveBeenCalledWith('existing-acc')
      expect(mockDbDeleteWhere).toHaveBeenCalledWith({ col: 'id', val: 'existing-acc' })
      expect(warnSpy).toHaveBeenCalledWith('Failed to delete connection from provider:', expect.any(Error))
    })

    it('does not run cleanup when the account does not exist', async () => {
      mockDbSelectLimit.mockResolvedValue([])

      const res = await app.request('http://localhost/api/connected-accounts/missing-account', {
        method: 'DELETE',
      })

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Connected account not found' })
      expect(mockCancelTriggersForConnectedAccount).not.toHaveBeenCalled()
      expect(mockDeleteConnection).not.toHaveBeenCalled()
      expect(mockDbDeleteWhere).not.toHaveBeenCalled()
    })

    it('stops deletion if trigger cancellation fails', async () => {
      mockDbSelectLimit.mockResolvedValue([{
        id: 'existing-acc',
        providerConnectionId: 'remote-conn',
        providerName: 'composio',
        toolkitSlug: 'github',
      }])
      mockCancelTriggersForConnectedAccount.mockRejectedValue(new Error('trigger cleanup failed'))

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = await app.request('http://localhost/api/connected-accounts/existing-acc', {
        method: 'DELETE',
      })

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'Failed to delete connected account' })
      expect(mockDeleteConnection).not.toHaveBeenCalled()
      expect(mockDbDeleteWhere).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith('Failed to delete connected account:', expect.any(Error))
    })
  })
})
