/**
 * Short-lived state shared across processes: each `runWithHostState` call is
 * one request, and requests share only the database, as isolates do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const grok = vi.hoisted(() => ({
  start: vi.fn(),
  poll: vi.fn(),
}))
vi.mock('@shared/lib/llm-provider/grok-oauth', () => ({ startGrokLogin: grok.start, pollGrokLogin: grok.poll }))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformBaseUrl: () => 'https://platform.example.com' }))

import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { hostState } from '@shared/lib/db/schema'
import { background, backgroundSettled, runWithRequestLifetime } from '@shared/lib/background'
import { heldLoginFor, holdLoginValues } from '@shared/lib/browser-vault/held-values'
import { consumeOAuthLogin, credentialsFromLogin, pollOAuthLogin, startOAuthLogin } from '@shared/lib/llm-provider/oauth-login'
import { platformPlanCache } from '@shared/lib/llm-provider/platform-plan-cache'
import { lockoutCounter, windowLimiter } from './counters'
import { expiringMap } from './expiring-map'
import { runWithHostState } from './scope'
import { databaseHostStateStore, type HostStateStore } from './store'

let handle: TestDatabase
let store: HostStateStore
const request = <T>(fn: () => Promise<T>) => runWithHostState(store, fn)

async function rawRows(prefix: string): Promise<Array<{ key: string; value: string }>> {
  return handle.db.select({ key: hostState.key, value: hostState.value }).from(hostState).where(sql`${hostState.key} LIKE ${prefix + '%'}`)
}

beforeEach(async () => {
  handle = await createTestDatabase()
  store = databaseHostStateStore(handle.db)
})

afterEach(async () => {
  vi.useRealTimers()
  await backgroundSettled()
  await handle.close()
})

describe('rate limits and lockouts', () => {
  it('counts hits from every request against one limit', async () => {
    const limiter = windowLimiter('llm-requests', 2, 60_000)
    expect(await request(() => limiter.hit('203.0.113.7'))).toBe(true)
    expect(await request(() => limiter.hit('203.0.113.7'))).toBe(true)
    expect(await request(() => limiter.hit('203.0.113.7'))).toBe(false)
    expect(await request(() => limiter.hit('198.51.100.4'))).toBe(true)
    expect(await rawRows('llm-requests:203.0.113.7')).toEqual([{ key: 'llm-requests:203.0.113.7', value: '3' }])
  })

  it('starts a new window once the old one lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const limiter = windowLimiter('auth-attempts', 1, 60_000)
    expect(await request(() => limiter.hit('203.0.113.7'))).toBe(true)
    expect(await request(() => limiter.hit('203.0.113.7'))).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect(await request(() => limiter.hit('203.0.113.7'))).toBe(true)
  })

  it('locks an account after failures spread across requests, until it lapses or a sign-in succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const lockouts = lockoutCounter('account-lockout')
    const email = 'ada@example.com'
    await request(() => lockouts.fail(email, 3, 30 * 60_000))
    await request(() => lockouts.fail(email, 3, 30 * 60_000))
    expect(await request(() => lockouts.lockedUntil(email, 3))).toBeNull()

    await request(() => lockouts.fail(email, 3, 30 * 60_000))
    expect(await request(() => lockouts.lockedUntil(email, 3))).toBe(Date.now() + 30 * 60_000)
    expect(await rawRows('account-lockout:')).toEqual([{ key: 'account-lockout:ada@example.com', value: '3' }])

    vi.advanceTimersByTime(30 * 60_000 + 1)
    expect(await request(() => lockouts.lockedUntil(email, 3))).toBeNull()
    await request(() => lockouts.fail(email, 3, 30 * 60_000))
    expect(await request(() => lockouts.lockedUntil(email, 3))).toBeNull()

    await request(() => lockouts.fail(email, 3, 30 * 60_000))
    await request(() => lockouts.clear(email))
    await request(() => lockouts.fail(email, 3, 30 * 60_000))
    expect(await request(() => lockouts.lockedUntil(email, 3))).toBeNull()
  })
})

describe('sealed values', () => {
  it('stores a sealed value encrypted, bound to its key', async () => {
    const secrets = expiringMap('test-secret', 60_000, z.object({ password: z.string() }), { sealed: true })
    await request(() => secrets.set('a', { password: 'hunter2' }))

    const [row] = await rawRows('test-secret:a')
    expect(row.value).not.toContain('hunter2')
    expect(await request(() => secrets.get('a'))).toEqual({ password: 'hunter2' })

    // A ciphertext copied to another key does not open there.
    await handle.db.insert(hostState).values({ key: 'test-secret:b', value: row.value, version: 1, expiresAt: Date.now() + 60_000 })
    expect(await request(() => secrets.get('b'))).toBeUndefined()
  })

  it('reads in a later request what an earlier step of a sign-in held, without storing the password in clear', async () => {
    const login = { username: 'octocat', values: { password: 'held-pw' }, origin: 'https://github.com', save: null }
    await request(() => holdLoginValues('agent-a', 's-1', 'github.com', login))

    expect(await request(() => heldLoginFor('agent-a', 's-1', 'github.com'))).toEqual(login)
    expect((await rawRows('held-login:')).map((r) => r.value).join()).not.toContain('held-pw')
  })
})

describe('subscription sign-in across requests', () => {
  const viewer = { userId: 'user-1', admin: true }
  const credential = { accessToken: 'access-abc', refreshToken: 'refresh-abc', expiresAt: 4_102_444_800_000, accountLabel: 'ada@example.com' }

  beforeEach(() => {
    grok.start.mockReset().mockResolvedValue({
      device: { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://accounts.x.ai/device', expires_in: 600, interval: 5 },
      endpoints: { token_endpoint: 'https://auth.x.ai/token', userinfo_endpoint: 'https://auth.x.ai/userinfo' },
    })
    grok.poll.mockReset()
  })

  it('polls a sign-in started in another request, once per interval, and hands its credential to a third', async () => {
    let answer!: (result: unknown) => void
    grok.poll.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const { id } = await request(() => startOAuthLogin(viewer, null))

    // Two requests find the poll due at once: one asks the provider, the other waits for the next round.
    const polls = Promise.all([request(() => pollOAuthLogin(id, viewer)), request(() => pollOAuthLogin(id, viewer))])
    await vi.waitFor(() => expect(grok.poll).toHaveBeenCalledTimes(1))
    answer({ credential })
    expect((await polls).map((r) => r.status).sort()).toEqual(['connected', 'pending'])
    expect(grok.poll).toHaveBeenCalledTimes(1)
    expect(await request(() => pollOAuthLogin(id, viewer))).toEqual({ status: 'connected', accountLabel: 'ada@example.com' })
    expect(grok.poll).toHaveBeenCalledWith('dev-1', 'https://auth.x.ai/token', 'https://auth.x.ai/userinfo')

    expect(await request(() => credentialsFromLogin(id, viewer, null))).toEqual(credential)
    expect((await rawRows('llm-oauth-login:')).map((r) => r.value).join()).not.toContain('access-abc')

    await request(() => consumeOAuthLogin(id))
    await expect(request(() => credentialsFromLogin(id, viewer, null))).rejects.toThrow('Sign-in expired')
  })
})

describe('plan policy cache', () => {
  it('serves a policy one request learned to the next request, from the shared store', async () => {
    const key = platformPlanCache.key('org_1', 'member_a')
    await request(async () => {
      platformPlanCache.remember(key, { planName: 'Pro 200', deniedModels: [] })
      await backgroundSettled()
    })
    expect(await rawRows('platform-plan:')).toHaveLength(1)

    const load = vi.fn(async () => null)
    expect(await request(() => platformPlanCache.get(key, load))).toEqual({ planName: 'Pro 200', deniedModels: [] })
    expect(load).not.toHaveBeenCalled()
  })
})

describe('background work in a request', () => {
  it('hands work that outlives the response to the request lifetime', async () => {
    const kept: Array<Promise<unknown>> = []
    let finish!: () => void
    runWithRequestLifetime((work) => kept.push(work), () => {
      background(new Promise<void>((resolve) => { finish = resolve }), { name: 'test.generate-session-name' })
    })
    background(Promise.resolve(), { name: 'test.outside-a-request' })

    expect(kept).toHaveLength(1)
    finish()
    await kept[0]
  })
})
