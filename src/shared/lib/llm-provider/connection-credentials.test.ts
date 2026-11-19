import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import { llmConnections, user } from '../db/schema'
import { connectionConfigSchema } from './connection-schema'
import { globalFeed } from '../notifications/global-feed'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null, exchange: vi.fn() }))
vi.mock('../db', () => ({ get db() { return state.db } }))
vi.mock('./codex-oauth', () => ({ refreshCodexCredential: state.exchange }))
vi.mock('./grok-oauth', () => ({ refreshGrokCredential: state.exchange }))
vi.mock('./kimi-oauth', () => ({ refreshKimiCredential: state.exchange }))
vi.mock('./minimax-oauth', () => ({ refreshMinimaxCredential: state.exchange }))
import { resolveConnectionCredential } from './connection-credentials'
import { shareConnection } from './connections'
let handle: TestDatabase
const expired = { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 0 }
const fresh = { accessToken: 'new', refreshToken: 'refresh-new', expiresAt: Date.now() + 3_600_000 }
async function seed(oauth = expired, id = 'connection', provider = 'grok-subscription') {
  await handle.db.insert(llmConnections).values({ id, provider, name: 'Grok', config: JSON.stringify(connectionConfigSchema.parse({ oauth })), createdAt: new Date(), updatedAt: new Date() }).run()
}
async function row(id = 'connection') { return handle.db.select().from(llmConnections).where(eq(llmConnections.id, id)).get() }
beforeEach(async () => { handle = await createTestDatabase(); state.db = handle.db; state.exchange.mockReset().mockResolvedValue(fresh) })
afterEach(async () => { await handle.close() })

describe('app-owned subscription credentials', () => {
  it.each(['grok-subscription', 'codex-subscription', 'kimi-subscription', 'minimax-subscription'])('coalesces %s refresh and persists the rotated pair', async provider => {
    await seed(expired, 'connection', provider)
    state.exchange.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 25)); return fresh })
    const credentials = await Promise.all(Array.from({ length: 5 }, () => resolveConnectionCredential('connection')))
    expect(state.exchange).toHaveBeenCalledTimes(1)
    expect(credentials.every(value => value.accessToken === 'new' && value.generation === 1)).toBe(true)
    expect(connectionConfigSchema.parse(JSON.parse((await row())!.config)).oauth).toEqual(fresh)
  })
  it('reuses a newer generation when another session rejects an old token', async () => {
    await seed()
    await resolveConnectionCredential('connection')
    await resolveConnectionCredential('connection', 0)
    expect(state.exchange).toHaveBeenCalledTimes(1)
  })
  it('refreshes a rejected current generation even before expiry', async () => {
    await seed({ ...expired, expiresAt: Date.now() + 3_600_000 })
    expect((await resolveConnectionCredential('connection')).accessToken).toBe('old')
    expect(state.exchange).not.toHaveBeenCalled()
    expect((await resolveConnectionCredential('connection', 0)).accessToken).toBe('new')
  })
  it('does not overwrite a reconnect that wins during refresh', async () => {
    await seed()
    state.exchange.mockImplementation(async () => {
      await handle.db.update(llmConnections).set({ config: JSON.stringify(connectionConfigSchema.parse({ oauth: { ...fresh, accessToken: 'reconnected' } })), generation: 7 }).where(eq(llmConnections.id, 'connection')).run()
      return fresh
    })
    expect((await resolveConnectionCredential('connection')).accessToken).toBe('reconnected')
    expect((await row())!.generation).toBe(7)
  })
  it('preserves rotated credentials when the owner shares during a refresh', async () => {
    await handle.db.insert(user).values({ id: 'admin', name: 'Admin', email: 'admin@example.test' }).run()
    await seed()
    await handle.db.update(llmConnections).set({ userId: 'admin' }).where(eq(llmConnections.id, 'connection')).run()
    const startedAt = Date.now()
    let elapsed = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed)
    state.exchange.mockImplementationOnce(async () => {
      await shareConnection('connection', { userId: 'admin', admin: true })
      // If sharing loses the rotated pair, skip waiting for the old lease and
      // simulate the provider rejecting reuse of its consumed refresh token.
      elapsed = 60_001
      return fresh
    }).mockRejectedValue(new CredentialRefreshError(401))
    try {
      await expect(resolveConnectionCredential('connection')).resolves.toMatchObject(fresh)
      expect(state.exchange).toHaveBeenCalledTimes(1)
      const shared = (await row())!
      expect(shared.userId).toBeNull()
      expect(connectionConfigSchema.parse(JSON.parse(shared.config)).oauth).toEqual(fresh)
    } finally {
      now.mockRestore()
    }
  })
  it('cannot resurrect a connection deleted during refresh', async () => {
    await seed()
    state.exchange.mockImplementation(async () => { await handle.db.delete(llmConnections).where(eq(llmConnections.id, 'connection')).run(); return fresh })
    await expect(resolveConnectionCredential('connection')).rejects.toThrow('no longer exists')
    expect(await row()).toBeUndefined()
  })
  it('shares transient failures across waiters and retries after backoff', async () => {
    await seed()
    state.exchange.mockRejectedValueOnce(new Error('network unavailable'))
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => resolveConnectionCredential('connection')))
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(state.exchange).toHaveBeenCalledTimes(1)
    const config = connectionConfigSchema.parse(JSON.parse((await row())!.config))
    expect(config.oauth).toMatchObject(expired)
    expect(config.oauth?.refreshLease).toBeUndefined()
    expect(config.oauth?.refreshFailure?.reconnectRequired).toBe(false)
    config.oauth!.refreshFailure!.retryAt = 0
    await handle.db.update(llmConnections).set({ config: JSON.stringify(config) }).where(eq(llmConnections.id, 'connection')).run()
    expect((await resolveConnectionCredential('connection')).accessToken).toBe('new')
    expect(state.exchange).toHaveBeenCalledTimes(2)
  })
  it('shares revoked-token failure until reconnection replaces the credentials', async () => {
    await seed()
    state.exchange.mockRejectedValue(new CredentialRefreshError(401))
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => resolveConnectionCredential('connection')))
    expect(results.every(result => result.status === 'rejected' && result.reason.status === 401)).toBe(true)
    expect(state.exchange).toHaveBeenCalledTimes(1)
    await expect(resolveConnectionCredential('connection')).rejects.toThrow('reconnect in Settings')
    expect(state.exchange).toHaveBeenCalledTimes(1)
    await handle.db.update(llmConnections).set({ config: JSON.stringify(connectionConfigSchema.parse({ oauth: fresh })), generation: 2 }).where(eq(llmConnections.id, 'connection')).run()
    expect((await resolveConnectionCredential('connection')).accessToken).toBe('new')
  })
  it('keeps accounts independent', async () => {
    await seed(expired, 'one'); await seed({ ...expired, refreshToken: 'other-refresh' }, 'two')
    state.exchange.mockImplementation(async old => ({ ...fresh, accessToken: old.refreshToken }))
    const [one, two] = await Promise.all([resolveConnectionCredential('one'), resolveConnectionCredential('two')])
    expect(one.accessToken).toBe('refresh-old'); expect(two.accessToken).toBe('other-refresh')
  })
})

describe('a sign-in the app could not refresh', () => {
  const announced = (publish: { mock: { calls: Parameters<typeof globalFeed.publish>[] } }) =>
    publish.mock.calls.map(([event]) => event).filter((event) => event.type === 'llm_connections_changed')

  it('is announced once it needs a reconnect: to everyone when shared, to its owner when personal', async () => {
    const publish = vi.spyOn(globalFeed, 'publish')
    state.exchange.mockRejectedValue(new CredentialRefreshError(401))
    await seed()
    await expect(resolveConnectionCredential('connection')).rejects.toMatchObject({ status: 401 })
    expect(announced(publish)).toEqual([{ type: 'llm_connections_changed' }])

    await handle.db.insert(user).values({ id: 'owner', name: 'Owner', email: 'owner@example.test' }).run()
    await seed(expired, 'personal')
    await handle.db.update(llmConnections).set({ userId: 'owner' }).where(eq(llmConnections.id, 'personal')).run()
    await expect(resolveConnectionCredential('personal')).rejects.toMatchObject({ status: 401 })
    expect(announced(publish)).toEqual([{ type: 'llm_connections_changed' }, { type: 'llm_connections_changed', recipientUserId: 'owner' }])

    // Asked again, it refuses from the saved failure: nothing new to tell.
    await expect(resolveConnectionCredential('connection')).rejects.toMatchObject({ status: 401 })
    expect(announced(publish)).toHaveLength(2)
    publish.mockRestore()
  })

  it('is not announced while the failure will be retried: no list shows it', async () => {
    const publish = vi.spyOn(globalFeed, 'publish')
    state.exchange.mockRejectedValue(new CredentialRefreshError(503))
    await seed()
    await expect(resolveConnectionCredential('connection')).rejects.toMatchObject({ status: 503 })
    expect(announced(publish)).toEqual([])
    publish.mockRestore()
  })
})
