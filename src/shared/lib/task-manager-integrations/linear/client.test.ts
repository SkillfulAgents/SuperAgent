/**
 * Token renewal across processes. Each `instance()` is a fresh copy of the
 * client module, with its own in-process maps, sharing this test's database
 * and AppState (whose holder lives on globalThis) as two processes would.
 */
vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
import { z } from 'zod'
import { appState, closeAppState, createLocalAppState, defineNamespace, digestKeyPart, initializeAppState, LocalAppStateBackend } from '../../app-state'
import { createAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { getLinearConfig, updateLinearConfig } from './store'
import type { LinearTokens } from './config'

type ClientModule = typeof import('./client')
type StoreModule = typeof import('./store')
async function instance(): Promise<{ client: ClientModule; store: StoreModule }> {
  vi.resetModules()
  const client = await import('./client')
  // Imported after the client with no reset between: the store copy it uses.
  const store = await import('./store')
  return { client, store }
}
const authorize = (module: ClientModule) => new module.LinearClient(id).authorization()
/** The client's unresolved-exchange records, read as another process's copy of the module would. */
const unresolvedExchanges = defineNamespace({ name: 'linear:unresolved-exchange', consistency: 'strong', schema: z.object({ owner: z.string() }), expiry: { ttlMs: 60_000, onUpdate: 'keep' } })

const scopes = 'read write app:mentionable app:assignable'
const tokens = (n: number | string, expiresAt: number): LinearTokens => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt, scope: scopes })
const granted = (n: number) => Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, scope: scopes })
const refused = () => new Response('{"error":"invalid_grant"}', { status: 400 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let id: string
/** The AppState clock: leases and unresolved-exchange records lapse only when a test moves it. */
let clock: number
/** The refresh token each exchange presented, in order. */
let exchanges: string[]
/** Linear's answer to each exchange, in order. */
let answers: Array<() => Promise<Response>>

beforeEach(async () => {
  handle = await createTestDatabase(); testDb = handle.db
  clock = Date.now()
  await closeAppState()
  await initializeAppState(createLocalAppState({ backend: new LocalAppStateBackend({ now: () => clock }) }))
  exchanges = []
  answers = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith('/oauth/token')) return Response.json({ data: { ok: true } })
    exchanges.push((init?.body as URLSearchParams).get('refresh_token')!)
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected token exchange')
    return answer()
  }))
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'client-secret', authorizationVersion: 'v1',
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app-user', appName: 'Agent Identity' },
    // Expired: the next use renews it.
    tokens: tokens(0, 1),
  } })
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await handle.close() })

describe('Linear token renewal across processes', () => {
  it('renews within 60 seconds of expiry, and not before', async () => {
    const { client } = await instance()
    await updateLinearConfig(id, config => ({ ...config, tokens: tokens(0, Date.now() + 61_000) }))
    await expect(authorize(client)).resolves.toMatchObject({ accessToken: 'access-0' })
    expect(exchanges).toEqual([])

    await updateLinearConfig(id, config => ({ ...config, tokens: tokens(0, Date.now() + 59_000) }))
    answers = [async () => granted(1)]
    await expect(authorize(client)).resolves.toMatchObject({ accessToken: 'access-1' })
    expect(exchanges).toEqual(['refresh-0'])
  })

  it('exchanges once for concurrent callers in two processes, and both get the saved tokens', async () => {
    const a = await instance()
    const b = await instance()
    const exchange = deferred<Response>()
    answers = [() => exchange.promise]
    const first = authorize(a.client)
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    // B finds the claim held and waits on the row instead of exchanging.
    const second = authorize(b.client)
    const sameProcess = authorize(b.client)
    await pause(150)
    expect(exchanges).toHaveLength(1)

    exchange.resolve(granted(1))
    const results = await Promise.all([first, second, sameProcess])
    expect(results.map(result => result.accessToken)).toEqual(['access-1', 'access-1', 'access-1'])
    expect(exchanges).toEqual(['refresh-0'])
    expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('refresh-1')
  })

  it('uses tokens another process saved before this one took the claim, without exchanging', async () => {
    const a = await instance()
    const b = await instance()
    answers = [async () => granted(1)]
    const state = appState()
    const insert = state.insertIfAbsent.bind(state)
    // A renews in full between B's read of the row and B's claim.
    vi.spyOn(state, 'insertIfAbsent').mockImplementationOnce(async (key, value, options) => {
      await authorize(a.client)
      return insert(key, value, options)
    })
    await expect(authorize(b.client)).resolves.toMatchObject({ accessToken: 'access-1' })
    expect(exchanges).toEqual(['refresh-0'])
  })

  it('fails the holder and the waiters when the authorization changes mid-renewal', async () => {
    const a = await instance()
    const b = await instance()
    const exchange = deferred<Response>()
    answers = [() => exchange.promise]
    const holder = authorize(a.client)
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    const waiter = authorize(b.client)
    const outcomes = Promise.allSettled([holder, waiter])
    // The user reconnects: a new authorization with its own tokens.
    await updateLinearConfig(id, config => ({ ...config, authorizationVersion: 'v2', tokens: tokens('new', Date.now() + 3_600_000) }))
    exchange.resolve(granted(1))
    const [held, waited] = await outcomes
    expect(held).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('changed during renewal') }) })
    expect(waited).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('changed during renewal') }) })
    expect(await getLinearConfig(id)).toMatchObject({ authorizationVersion: 'v2', tokens: { refreshToken: 'refresh-new' } })
  })

  it('does not let a holder that lost its claim save while another process holds it', async () => {
    const a = await instance()
    const b = await instance()
    const first = deferred<Response>()
    const second = deferred<Response>()
    answers = [() => first.promise, () => second.promise]
    const stalled = authorize(a.client)
    await vi.waitFor(() => expect(exchanges).toHaveLength(1))
    // A stalls past its lease without renewing; B takes the claim over.
    clock += 31_000
    const successor = authorize(b.client)
    await vi.waitFor(() => expect(exchanges).toHaveLength(2))

    // A's result arrives while B holds the claim: A must not write.
    first.resolve(granted(1))
    await pause(150)
    expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('refresh-0')

    // Linear honoured both exchanges; B saves its own, and A takes it from the row.
    second.resolve(granted(2))
    const results = await Promise.all([stalled, successor])
    expect(results.map(result => result.accessToken)).toEqual(['access-2', 'access-2'])
    expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('refresh-2')
  })

  it('does not let a delayed holder overwrite newer credentials', async () => {
    const a = await instance()
    const b = await instance()
    answers = [async () => granted(1), async () => granted(2)]
    const save = a.store.updateLinearConfig
    // A has confirmed its claim and is about to write when it stalls; its lease
    // lapses, B renews in full, and only then does A's write land.
    vi.spyOn(a.store, 'updateLinearConfig').mockImplementationOnce(async (...args) => {
      clock += 31_000
      await expect(authorize(b.client)).resolves.toMatchObject({ accessToken: 'access-2' })
      return save(...args)
    })
    await expect(authorize(a.client)).rejects.toThrow('changed during renewal')
    expect(exchanges).toEqual(['refresh-0', 'refresh-0'])
    expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('refresh-2')
  })

  it('does not send an exchange once the claim was lost while recording it', async () => {
    const a = await instance()
    const b = await instance()
    answers = [async () => granted(1)]
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    // A stalls writing its unresolved-exchange record (its first conditional
    // write: no renewal has run yet). Its lease lapses, and B renews in full.
    vi.spyOn(state, 'compareAndSet').mockImplementationOnce(async (key, expected, value, options) => {
      clock += 31_000
      await expect(authorize(b.client)).resolves.toMatchObject({ accessToken: 'access-1' })
      return compareAndSet(key, expected, value, options)
    })
    await expect(authorize(a.client)).rejects.toMatchObject({ name: 'LeaseLostError' })
    expect(exchanges).toEqual(['refresh-0'])
    expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('refresh-1')
    // Nothing was sent, so A leaves no record that would make a later refusal
    // of that token look uncertain.
    expect(await appState().get(unresolvedExchanges.key(id, 'v1', digestKeyPart('refresh-0')))).toBeNull()
  })

  it('revokes when Linear refuses a token that no earlier exchange spent', async () => {
    const { client } = await instance()
    answers = [async () => refused()]
    await expect(authorize(client)).rejects.toBeInstanceOf(client.LinearAuthorizationError)
    expect(await getLinearConfig(id)).not.toHaveProperty('tokens')
    expect((await getLinearConfig(id)).authorizationError).toContain('Reconnect')
    expect((await getAgentIntegration(id))?.status).toBe('disconnected')
  })

  describe('an exchange whose outcome is unknown', () => {
    it('keeps the authorization when the token was rotated for a holder that lost its claim, and that holder saves its result', async () => {
      const a = await instance()
      const b = await instance()
      const first = deferred<Response>()
      // Linear rotates the token for A's exchange, so it refuses B's.
      answers = [() => first.promise, async () => refused()]
      const stalled = authorize(a.client)
      await vi.waitFor(() => expect(exchanges).toHaveLength(1))
      clock += 31_000
      // B takes over, knows A's exchange is unresolved, and finds no result
      // in the row: a transient error, not a revocation.
      await expect(authorize(b.client)).rejects.toBeInstanceOf(b.client.LinearRenewalPendingError)
      expect(exchanges).toEqual(['refresh-0', 'refresh-0'])
      expect(await getLinearConfig(id)).toMatchObject({ tokens: { refreshToken: 'refresh-0' } })
      expect((await getLinearConfig(id)).authorizationError).toBeUndefined()
      expect((await getAgentIntegration(id))?.status).toBe('active')

      // A's result arrives: it takes the claim again and saves it.
      first.resolve(granted(1))
      await expect(stalled).resolves.toMatchObject({ accessToken: 'access-1' })
      expect((await getLinearConfig(id)).tokens?.refreshToken).toBe('refresh-1')
      await expect(authorize(b.client)).resolves.toMatchObject({ accessToken: 'access-1' })
      expect(exchanges).toHaveLength(2)
    })

    it('uses a result saved late instead of revoking', async () => {
      const a = await instance()
      answers = [async () => { throw new TypeError('fetch failed') }, async () => {
        // The earlier exchange's result is saved while Linear answers this one.
        await updateLinearConfig(id, config => ({ ...config, tokens: tokens(1, Date.now() + 3_600_000) }))
        return refused()
      }]
      await expect(authorize(a.client)).rejects.toThrow('fetch failed')
      await expect(authorize(a.client)).resolves.toMatchObject({ accessToken: 'access-1' })
      expect((await getAgentIntegration(id))?.status).toBe('active')
    })

    it('revokes on a refusal once the window from the first unresolved exchange has passed', async () => {
      const a = await instance()
      const b = await instance()
      answers = [async () => { throw new TypeError('fetch failed') }, async () => refused(), async () => refused()]
      // The request fails with no answer: Linear may or may not have rotated the token.
      await expect(authorize(a.client)).rejects.toThrow('fetch failed')

      clock += 40_000
      await expect(authorize(b.client)).rejects.toBeInstanceOf(b.client.LinearRenewalPendingError)
      expect(await getLinearConfig(id)).toMatchObject({ tokens: { refreshToken: 'refresh-0' } })

      // A minute after the first unresolved exchange (not after the latest
      // try), nothing can still save a result: the refusal is conclusive.
      clock += 21_000
      await expect(authorize(b.client)).rejects.toBeInstanceOf(b.client.LinearAuthorizationError)
      expect(exchanges).toEqual(['refresh-0', 'refresh-0', 'refresh-0'])
      expect(await getLinearConfig(id)).not.toHaveProperty('tokens')
      expect((await getLinearConfig(id)).authorizationError).toContain('Reconnect')
    })
  })
})
