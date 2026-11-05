/**
 * Device sign-in across processes. Each `instance()` is a fresh copy of the
 * module, with its own module state, sharing this test's AppState (whose
 * holder lives on globalThis) as two processes would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providers = vi.hoisted(() => ({
  startGrok: vi.fn(), pollGrok: vi.fn(),
  startCodex: vi.fn(), pollCodex: vi.fn(),
  startKimi: vi.fn(), pollKimi: vi.fn(),
  startMinimax: vi.fn(), pollMinimax: vi.fn(),
}))
vi.mock('./grok-oauth', async original => ({ ...(await original<object>()), startGrokLogin: providers.startGrok, pollGrokLogin: providers.pollGrok }))
vi.mock('./codex-oauth', async original => ({ ...(await original<object>()), startCodexLogin: providers.startCodex, pollCodexLogin: providers.pollCodex }))
vi.mock('./kimi-oauth', async original => ({ ...(await original<object>()), startKimiLogin: providers.startKimi, pollKimiLogin: providers.pollKimi }))
vi.mock('./minimax-oauth', async original => ({ ...(await original<object>()), startMinimaxLogin: providers.startMinimax, pollMinimaxLogin: providers.pollMinimax }))

import { appState } from '../app-state'
import { OAUTH_LOGIN_LIMIT, OAUTH_LOGIN_START_MS, pendingLoginsKey, reserveOAuthLoginPlace } from './oauth-login-admission'
import { oauthLoginKey } from './oauth-login'
import type { ConnectionViewer } from './connections'

type LoginModule = typeof import('./oauth-login')
async function instance(): Promise<LoginModule> {
  vi.resetModules()
  return import('./oauth-login')
}

const alice: ConnectionViewer = { userId: 'alice', admin: false }
const bob: ConnectionViewer = { userId: 'bob', admin: false }
const admin: ConnectionViewer = { userId: 'admin', admin: true }
const EXPIRED = 'Sign-in expired. Start again.'
const TOO_MANY = 'Too many pending sign-ins. Please retry shortly.'
const T0 = Date.UTC(2026, 10, 5, 12)
const EXPIRES_IN = 900

const grokDevice = (n = 1) => ({ device_code: `private-device-${n}`, user_code: `CODE-${n}`, verification_uri: 'https://accounts.x.ai/device', expires_in: EXPIRES_IN, interval: 5 })
const credential = (label = 'Alice Grok') => ({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: T0 + 3_600_000, accountLabel: label })
const pending = { pending: 'authorization_pending' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

const record = async (id: string) => appState().get(oauthLoginKey(id))
const places = async () => (await appState().get(pendingLoginsKey()))?.value.places ?? []

type Method = 'compareAndSet' | 'consume' | 'insertIfAbsent'
/**
 * Makes the next `method` call on `namespace` lose its answer: it lands (unless
 * `lands` is false) and then throws, as a response that never arrives would.
 */
function loseAnswer(method: Method, namespace: string, { lands = true, times = 1 } = {}) {
  const state = appState() as unknown as Record<Method, (...args: unknown[]) => Promise<unknown>>
  const original = state[method].bind(state)
  let left = times
  return vi.spyOn(state, method).mockImplementation(async (...args: unknown[]) => {
    const key = args[0] as { namespace: { name: string } }
    if (left > 0 && key.namespace.name === namespace) {
      left--
      if (lands) await original(...args)
      throw new Error('AppState answer lost')
    }
    return original(...args)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  providers.startGrok.mockImplementation(async () => ({ device: grokDevice(), endpoints: { token_endpoint: 'https://auth.x.ai/token', userinfo_endpoint: 'https://auth.x.ai/userinfo' } }))
  providers.pollGrok.mockImplementation(async () => ({ credential: credential() }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const mock of Object.values(providers)) mock.mockReset()
})

describe('polling across processes', () => {
  it.each([
    {
      provider: 'grok-subscription' as const,
      options: {},
      start: () => providers.startGrok,
      poll: () => providers.pollGrok,
      polled: ['private-device-1', 'https://auth.x.ai/token', 'https://auth.x.ai/userinfo'],
    },
    {
      provider: 'codex-subscription' as const,
      options: {},
      start: () => providers.startCodex.mockResolvedValue({ device: { device_code: 'private-device-auth', user_code: 'CODEX-1', verification_uri: 'https://auth.openai.com/codex/device', verification_uri_complete: undefined, expires_in: 900, interval: 5 } }),
      poll: () => providers.pollCodex,
      polled: ['private-device-auth', 'CODEX-1'],
    },
    {
      provider: 'kimi-subscription' as const,
      options: { region: 'cn' },
      start: () => providers.startKimi.mockResolvedValue({ device: { ...grokDevice(), verification_uri: 'https://auth.kimi.com/device' } }),
      poll: () => providers.pollKimi,
      polled: ['private-device-1', 'cn'],
    },
    {
      provider: 'minimax-subscription' as const,
      options: {},
      start: () => providers.startMinimax.mockResolvedValue({ verifier: 'private-verifier', userCode: 'MM-1', device: { device_code: 'state', user_code: 'MM-1', verification_uri: 'https://account.minimax.io/device', expires_in: 600, interval: 3 } }),
      poll: () => providers.pollMinimax,
      polled: [expect.objectContaining({ userCode: 'MM-1', verifier: 'private-verifier' }), 'global'],
    },
  ])('rebuilds the $provider poll in a process that did not start it', async ({ provider, options, start, poll, polled }) => {
    start()
    poll().mockResolvedValue({ credential: credential('Account') })
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice', undefined, provider, options)
    expect(JSON.stringify(login)).not.toContain('private')

    await expect(b.pollOAuthLogin(login.id, alice)).resolves.toEqual({ status: 'connected', accountLabel: 'Account' })
    expect(poll()).toHaveBeenCalledTimes(1)
    expect(poll()).toHaveBeenCalledWith(...polled)
    // The other process sees it completed without asking again.
    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toEqual({ status: 'connected', accountLabel: 'Account' })
    expect((await a.completedOAuthLogin(login.id, alice, 'alice', undefined, provider)).credential.accountLabel).toBe('Account')
    expect(poll()).toHaveBeenCalledTimes(1)
  })

  it('asks the provider once for concurrent polls in two processes', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const answer = deferred<unknown>()
    providers.pollGrok.mockImplementation(() => answer.promise)

    const polls = Promise.all([a, b, a, b, a, b, a, b].map(module => module.pollOAuthLogin(login.id, alice)))
    await vi.waitFor(() => expect(providers.pollGrok).toHaveBeenCalledTimes(1))
    await pause(50)
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
    answer.resolve({ credential: credential() })

    const results = await polls
    expect(results.filter(result => result.status === 'connected')).toHaveLength(1)
    expect(results.filter(result => result.status === 'pending')).toHaveLength(7)
    await expect(b.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
  })

  it('waits out the interval between polls, and slow_down adds five seconds', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    providers.pollGrok.mockResolvedValue(pending)

    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toEqual({ status: 'pending' })
    await expect(b.pollOAuthLogin(login.id, alice)).resolves.toEqual({ status: 'pending' })
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
    advance(5_000)
    providers.pollGrok.mockResolvedValueOnce({ pending: 'slow_down' })
    await b.pollOAuthLogin(login.id, alice)
    expect(providers.pollGrok).toHaveBeenCalledTimes(2)
    advance(5_000)
    await a.pollOAuthLogin(login.id, alice)
    expect(providers.pollGrok).toHaveBeenCalledTimes(2)
    advance(5_000)
    await a.pollOAuthLogin(login.id, alice)
    expect(providers.pollGrok).toHaveBeenCalledTimes(3)
    expect((await record(login.id))?.value.schedule.intervalSeconds).toBe(10)
  })

  it('does not ask the provider when the lease would not outlast the request', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    const spy = vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
      const result = await compareAndSet(key, expected, value, options)
      // The renewal right before the request is answered 20 s after it was
      // sent: 40 s of the lease are left, less than the request may take.
      if (key.namespace.name === 'claim:llm-oauth-poll') advance(20_000)
      return result
    })
    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toEqual({ status: 'pending' })
    expect(providers.pollGrok).not.toHaveBeenCalled()

    // The lease was given up at once, so the next poll asks.
    spy.mockImplementation(compareAndSet)
    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
  })
})

describe('late answers', () => {
  it('drops a credential that arrives after the sign-in was cancelled', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const answer = deferred<unknown>()
    providers.pollGrok.mockImplementation(() => answer.promise)
    const polling = a.pollOAuthLogin(login.id, alice)
    await vi.waitFor(() => expect(providers.pollGrok).toHaveBeenCalledTimes(1))

    await expect(b.cancelOAuthLogin(login.id, alice)).resolves.toBe(true)
    answer.resolve({ credential: credential() })
    await expect(polling).rejects.toThrow(EXPIRED)
    expect(await record(login.id)).toBeNull()
    await expect(b.completedOAuthLogin(login.id, alice, 'alice')).rejects.toThrow(EXPIRED)
  })

  it('does not write the pending answer of a holder that stalled past its lease over its successor', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    providers.pollGrok.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const stalled = a.pollOAuthLogin(login.id, alice)
    await vi.waitFor(() => expect(providers.pollGrok).toHaveBeenCalledTimes(1))
    // A stalls past its lease; B takes it over and asks again.
    advance(61_000)
    const successor = b.pollOAuthLogin(login.id, alice)
    await vi.waitFor(() => expect(providers.pollGrok).toHaveBeenCalledTimes(2))

    const started = (await record(login.id))!.value.writeId
    first.resolve(pending)
    await expect(stalled).resolves.toEqual({ status: 'pending' })
    expect((await record(login.id))!.value.writeId).toBe(started)

    second.resolve({ credential: credential() })
    await expect(successor).resolves.toMatchObject({ status: 'connected' })
    expect((await record(login.id))!.value.status.state).toBe('completed')
  })

  it('does not let a holder that stalled past its lease overwrite what its successor wrote', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const first = deferred<unknown>()
    providers.pollGrok
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => { throw new Error('Grok sign-in expired. Start again.') })
    const stalled = a.pollOAuthLogin(login.id, alice)
    await vi.waitFor(() => expect(providers.pollGrok).toHaveBeenCalledTimes(1))
    advance(61_000)
    await expect(b.pollOAuthLogin(login.id, alice)).rejects.toThrow('Grok sign-in expired. Start again.')

    // A's credential arrives after B wrote the provider's refusal: dropped.
    first.resolve({ credential: credential() })
    await expect(stalled).rejects.toThrow('Grok sign-in expired. Start again.')
    expect((await record(login.id))!.value.status).toEqual({ state: 'failed', message: 'Grok sign-in expired. Start again.' })
  })

  it('still writes the credential of a holder that stalled past its lease when nothing was written since', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const answer = deferred<unknown>()
    providers.pollGrok.mockImplementation(() => answer.promise)
    const stalled = a.pollOAuthLogin(login.id, alice)
    await vi.waitFor(() => expect(providers.pollGrok).toHaveBeenCalledTimes(1))
    advance(61_000)
    answer.resolve({ credential: credential() })
    await expect(stalled).resolves.toMatchObject({ status: 'connected' })
    expect((await record(login.id))!.value.status.state).toBe('completed')
  })

  it('lets one of two saves take a credential, and refuses a save after a cancel', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    await a.pollOAuthLogin(login.id, alice)
    const [readA, readB] = await Promise.all([a.completedOAuthLogin(login.id, alice, 'alice'), b.completedOAuthLogin(login.id, alice, 'alice')])
    const claims = await Promise.allSettled([a.claimOAuthLogin(readA), b.claimOAuthLogin(readB)])
    expect(claims.filter(claim => claim.status === 'fulfilled')).toHaveLength(1)
    expect(claims.find(claim => claim.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: EXPIRED }) })
    // Taken by a save: no longer cancellable, and still connected for the poller.
    await expect(b.cancelOAuthLogin(login.id, alice)).resolves.toBe(false)
    await expect(b.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })

    const other = await a.startOAuthLogin(alice, 'alice')
    await a.pollOAuthLogin(other.id, alice)
    const read = await b.completedOAuthLogin(other.id, alice, 'alice')
    await expect(a.cancelOAuthLogin(other.id, alice)).resolves.toBe(true)
    await expect(b.claimOAuthLogin(read)).rejects.toThrow(EXPIRED)
  })

  it('hands the credential back when the save fails, for another save', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    await a.pollOAuthLogin(login.id, alice)
    const claim = await a.claimOAuthLogin(await a.completedOAuthLogin(login.id, alice, 'alice'))
    await expect(a.completedOAuthLogin(login.id, alice, 'alice')).rejects.toThrow('Complete sign-in for this connection first')
    await a.releaseOAuthLoginClaim(claim)
    const again = await a.claimOAuthLogin(await a.completedOAuthLogin(login.id, alice, 'alice'))
    await a.consumeOAuthLogin(again)
    expect(await record(login.id)).toBeNull()
    expect(await places()).toEqual([])
  })
})

describe('expiry', () => {
  it('keeps the provider\'s device expiry through every write, and ends the sign-in then', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    const deadline = T0 + EXPIRES_IN * 1000
    expect(login.expiresAt).toBe(deadline)
    const expiry = async () => (await record(login.id))?.expiresAt
    expect(await expiry()).toBe(deadline)
    expect(await places()).toEqual([{ id: login.id, expiresAt: deadline }])

    providers.pollGrok.mockResolvedValueOnce(pending).mockResolvedValueOnce({ pending: 'slow_down' })
    advance(100_000)
    await a.pollOAuthLogin(login.id, alice)
    expect(await expiry()).toBe(deadline)
    advance(100_000)
    await b.pollOAuthLogin(login.id, alice)
    expect(await expiry()).toBe(deadline)
    advance(600_000)
    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })
    expect(await expiry()).toBe(deadline)
    const claim = await b.claimOAuthLogin(await b.completedOAuthLogin(login.id, alice, 'alice'))
    expect(claim.entry.expiresAt).toBe(deadline)
    await b.releaseOAuthLoginClaim(claim)
    expect(await expiry()).toBe(deadline)
    expect(await places()).toEqual([{ id: login.id, expiresAt: deadline }])

    advance(deadline - Date.now())
    expect(await record(login.id)).toBeNull()
    expect(await places()).toEqual([])
    await expect(a.pollOAuthLogin(login.id, alice)).rejects.toThrow(EXPIRED)
    await expect(a.completedOAuthLogin(login.id, alice, 'alice')).rejects.toThrow(EXPIRED)
  })
})

describe('the pending sign-in limit', () => {
  it('admits exactly the free places to 105 concurrent starts in two processes', async () => {
    const a = await instance()
    const b = await instance()
    for (let i = 0; i < 10; i++) await a.startOAuthLogin(alice, 'alice')
    const starts = await Promise.allSettled(Array.from({ length: 105 }, (_, i) => (i % 2 ? a : b).startOAuthLogin(alice, 'alice')))
    expect(starts.filter(start => start.status === 'fulfilled')).toHaveLength(OAUTH_LOGIN_LIMIT - 10)
    expect(new Set(starts.flatMap(start => start.status === 'rejected' ? [(start.reason as Error).message] : []))).toEqual(new Set([TOO_MANY]))
    // A refused start never asked the provider.
    expect(providers.startGrok).toHaveBeenCalledTimes(OAUTH_LOGIN_LIMIT)
    expect(await places()).toHaveLength(OAUTH_LOGIN_LIMIT)
  })

  it('frees a place on cancel, on save, after a failed start, and at the device expiry', async () => {
    const a = await instance()
    const b = await instance()
    const logins = []
    for (let i = 0; i < OAUTH_LOGIN_LIMIT; i++) logins.push(await a.startOAuthLogin(alice, 'alice'))
    await expect(b.startOAuthLogin(alice, 'alice')).rejects.toThrow(TOO_MANY)

    await b.cancelOAuthLogin(logins[0].id, alice)
    const replacement = await b.startOAuthLogin(alice, 'alice')
    await expect(a.startOAuthLogin(alice, 'alice')).rejects.toThrow(TOO_MANY)

    await b.pollOAuthLogin(replacement.id, alice)
    await b.consumeOAuthLogin(await b.claimOAuthLogin(await b.completedOAuthLogin(replacement.id, alice, 'alice')))
    providers.startGrok.mockRejectedValueOnce(new Error('Could not start Grok sign-in'))
    await expect(a.startOAuthLogin(alice, 'alice')).rejects.toThrow('Could not start Grok sign-in')
    expect(await places()).toHaveLength(OAUTH_LOGIN_LIMIT - 1)
    await a.startOAuthLogin(alice, 'alice')
    await expect(a.startOAuthLogin(alice, 'alice')).rejects.toThrow(TOO_MANY)

    advance(EXPIRES_IN * 1000)
    await expect(a.startOAuthLogin(alice, 'alice')).resolves.toMatchObject({ code: 'CODE-1' })
    expect(await places()).toHaveLength(1)
  })

  it('frees the place of a start whose process went away once its reservation runs out', async () => {
    const a = await instance()
    for (let i = 0; i < OAUTH_LOGIN_LIMIT - 1; i++) await a.startOAuthLogin(alice, 'alice')
    // A process reserved the last place and died before the provider answered.
    expect(await reserveOAuthLoginPlace(crypto.randomUUID())).toBe(true)
    await expect(a.startOAuthLogin(alice, 'alice')).rejects.toThrow(TOO_MANY)
    advance(OAUTH_LOGIN_START_MS)
    await expect(a.startOAuthLogin(alice, 'alice')).resolves.toMatchObject({ code: 'CODE-1' })
  })
})

describe('cancellation, failure and who may act', () => {
  it('lets only the user who started a sign-in poll, save or cancel it', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    await expect(b.pollOAuthLogin(login.id, bob)).rejects.toThrow(EXPIRED)
    await expect(b.pollOAuthLogin(login.id, admin)).rejects.toThrow(EXPIRED)
    await expect(b.cancelOAuthLogin(login.id, bob)).resolves.toBe(false)
    await expect(b.cancelOAuthLogin(login.id, admin)).resolves.toBe(false)
    expect(providers.pollGrok).not.toHaveBeenCalled()
    await expect(b.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })
    await expect(a.completedOAuthLogin(login.id, bob, 'alice')).rejects.toThrow(EXPIRED)
    // The sign-in is bound to its connection, too.
    await expect(a.completedOAuthLogin(login.id, alice, null)).rejects.toThrow('Complete sign-in for this connection first')
    await expect(a.completedOAuthLogin(login.id, alice, 'alice', 'other-connection')).rejects.toThrow('Complete sign-in for this connection first')
    await expect(a.completedOAuthLogin(login.id, alice, 'alice', undefined, 'codex-subscription')).rejects.toThrow('Complete sign-in for this connection first')
    await expect(a.pollOAuthLogin('not-a-sign-in', alice)).rejects.toThrow(EXPIRED)
    await expect(a.cancelOAuthLogin('not-a-sign-in', alice)).resolves.toBe(false)
  })

  it('takes an admin to poll a global connection\'s sign-in, even for the user who started it', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(admin, null)
    await expect(a.pollOAuthLogin(login.id, { userId: 'admin', admin: false })).rejects.toThrow(EXPIRED)
    await expect(a.cancelOAuthLogin(login.id, { userId: 'admin', admin: false })).resolves.toBe(false)
    await expect(a.pollOAuthLogin(login.id, admin)).resolves.toMatchObject({ status: 'connected' })
  })

  it('cancels a pending sign-in for good', async () => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    providers.pollGrok.mockResolvedValue(pending)
    await a.pollOAuthLogin(login.id, alice)
    await expect(b.cancelOAuthLogin(login.id, alice)).resolves.toBe(true)
    await expect(a.pollOAuthLogin(login.id, alice)).rejects.toThrow(EXPIRED)
    await expect(a.cancelOAuthLogin(login.id, alice)).resolves.toBe(false)
    expect(await places()).toEqual([])
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['access_denied', new Error('Grok sign-in was declined'), 'Grok sign-in was declined'],
    ['expired_token', new Error('Grok sign-in expired. Start again.'), 'Grok sign-in expired. Start again.'],
    ['a network error', new TypeError('fetch failed: connect ECONNREFUSED private-host'), 'Sign-in failed. Start again.'],
  ])('reports %s to every later poll in any process without asking again', async (_, error, message) => {
    const a = await instance()
    const b = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    providers.pollGrok.mockRejectedValue(error)
    await expect(a.pollOAuthLogin(login.id, alice)).rejects.toThrow(message)
    advance(10_000)
    await expect(b.pollOAuthLogin(login.id, alice)).rejects.toThrow(message)
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
    await expect(b.completedOAuthLogin(login.id, alice, 'alice')).rejects.toThrow('Complete sign-in for this connection first')
    // A failed sign-in keeps its place until its device code expires, as before.
    expect(await places()).toHaveLength(1)
  })
})

describe('answers that are lost', () => {
  it('reports what a poll wrote when the write landed but its answer was lost', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    loseAnswer('compareAndSet', 'oauth:llm')
    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })
    await expect(a.pollOAuthLogin(login.id, alice)).resolves.toMatchObject({ status: 'connected' })
    expect(providers.pollGrok).toHaveBeenCalledTimes(1)
  })

  it('saves when the claim landed but its answer was lost', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    await a.pollOAuthLogin(login.id, alice)
    const read = await a.completedOAuthLogin(login.id, alice, 'alice')
    loseAnswer('compareAndSet', 'oauth:llm')
    const claim = await a.claimOAuthLogin(read)
    expect(claim.entry.value.status.state).toBe('saving')
    await a.consumeOAuthLogin(claim)
    expect(await record(login.id)).toBeNull()
  })

  it('tries a claim again when its answer was lost before it landed', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    await a.pollOAuthLogin(login.id, alice)
    const read = await a.completedOAuthLogin(login.id, alice, 'alice')
    loseAnswer('compareAndSet', 'oauth:llm', { lands: false })
    await expect(a.claimOAuthLogin(read)).resolves.toMatchObject({ entry: { value: { status: { state: 'saving' } } } })
  })

  it.each([true, false])('removes a saved sign-in when the removal\'s answer was lost (it landed: %s)', async (lands) => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    await a.pollOAuthLogin(login.id, alice)
    const claim = await a.claimOAuthLogin(await a.completedOAuthLogin(login.id, alice, 'alice'))
    loseAnswer('consume', 'oauth:llm', { lands })
    await a.consumeOAuthLogin(claim)
    expect(await record(login.id)).toBeNull()
    expect(await places()).toEqual([])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('starts when writing the sign-in or its place landed but the answer was lost', async () => {
    const a = await instance()
    const insert = loseAnswer('insertIfAbsent', 'oauth:llm')
    const first = await a.startOAuthLogin(alice, 'alice')
    expect((await record(first.id))?.value.status.state).toBe('pending')
    insert.mockRestore()
    // The reservation's answer and then the activation's.
    loseAnswer('compareAndSet', 'oauth:llm:pending', { times: 2 })
    const second = await a.startOAuthLogin(alice, 'alice')
    expect(await places()).toEqual([{ id: first.id, expiresAt: first.expiresAt }, { id: second.id, expiresAt: second.expiresAt }])
    await expect(a.pollOAuthLogin(second.id, alice)).resolves.toMatchObject({ status: 'connected' })
  })

  it('leaves nothing behind when a start cannot write its sign-in', async () => {
    const a = await instance()
    const insert = loseAnswer('insertIfAbsent', 'oauth:llm', { times: 3 })
    await expect(a.startOAuthLogin(alice, 'alice')).rejects.toThrow('AppState answer lost')
    expect(insert).toHaveBeenCalledTimes(3)
    // The first attempt landed; the start removed it.
    const key = insert.mock.calls[0][0] as ReturnType<typeof oauthLoginKey>
    expect(await appState().get(key)).toBeNull()
    expect(await places()).toEqual([])
  })

  it('frees the place of a cancel whose removal landed but whose answer was lost', async () => {
    const a = await instance()
    const login = await a.startOAuthLogin(alice, 'alice')
    loseAnswer('consume', 'oauth:llm')
    await expect(a.cancelOAuthLogin(login.id, alice)).rejects.toThrow('AppState answer lost')
    expect(await record(login.id)).toBeNull()
    expect(await places()).toEqual([])
  })
})
