import { afterEach, describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'
import {
  claimHeldParts,
  forgetHeldLogin,
  heldLoginFor,
  heldLoginKey,
  HELD_CLAIM_MS,
  HOLD_MS,
  holdLoginValues,
  recentSignInIdentity,
  releaseHeldValues,
  rememberSignInIdentity,
  settleHeldClaim,
  signInIdentityKey,
  type HeldLogin,
  type HeldLoginRead,
} from './held-values'
import type { HeldLoginRecord } from './held-values-schema'

const SITE = 'github.com'
const MINUTE = 60_000

const login = (values: Record<string, string>, overrides: Partial<HeldLogin> = {}): HeldLogin => ({
  username: 'octocat',
  values,
  origin: 'https://github.com',
  save: null,
  ...overrides,
})

const hold = (values: Record<string, string>, overrides: Partial<HeldLogin> = {}) =>
  holdLoginValues('agent-a', 's-1', SITE, login(values, overrides))

async function read(username?: string): Promise<HeldLoginRead> {
  const held = await heldLoginFor('agent-a', 's-1', SITE, username)
  if (!held) throw new Error('Nothing is held')
  return held
}

const freeValues = async () => (await heldLoginFor('agent-a', 's-1', SITE))?.values ?? null

const THREE_PARTS = { password: 'pw-1', 'text:workspace': 'acme', 'text:company id': '42' }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('held sign-in values in AppState', () => {
  it('keys the record by agent, session and a digest of the site', async () => {
    await hold({ password: 'pw-1' })
    await rememberSignInIdentity('agent-a', 's-1', SITE, 'octocat')
    for (const key of [heldLoginKey('agent-a', 's-1', SITE), signInIdentityKey('agent-a', 's-1', SITE)]) {
      expect(key.path).toMatch(/^vault:(held|identity)\/agent-a:s-1:/)
      expect(key.path).not.toContain('github')
    }
    expect((await appState().get(heldLoginKey('agent-a', 's-1', SITE)))?.value.parts.password.value).toBe('pw-1')
    // Another session, agent or site holds nothing.
    expect(await heldLoginFor('agent-a', 's-2', SITE)).toBeNull()
    expect(await heldLoginFor('agent-b', 's-1', SITE)).toBeNull()
    expect(await heldLoginFor('agent-a', 's-1', 'gitlab.com')).toBeNull()
  })

  it('hands a held step over to another instance of the service', async () => {
    await hold({ password: 'pw-1' }, { save: { owner: 'alice', origin: 'https://github.com' } })
    await rememberSignInIdentity('agent-a', 's-1', SITE, 'octocat')

    // A second "process": its own copy of every module, the same AppState.
    vi.resetModules()
    const other = await import('./held-values')
    expect(other.heldLoginFor).not.toBe(heldLoginFor)
    const held = await other.heldLoginFor('agent-a', 's-1', SITE, 'Octocat')
    expect(held).toMatchObject({ username: 'octocat', values: { password: 'pw-1' }, save: { owner: 'alice', origin: 'https://github.com' } })
    expect(await other.recentSignInIdentity('agent-a', 's-1', SITE)).toBe('octocat')

    // It fills the step: this instance sees it used.
    const claim = await other.claimHeldParts('agent-a', 's-1', SITE, held!, ['password'])
    expect(claim?.values).toEqual({ password: 'pw-1' })
    expect(await heldLoginFor('agent-a', 's-1', SITE)).toBeNull()
    await other.settleHeldClaim(claim!, ['password'])
    expect(await appState().get(heldLoginKey('agent-a', 's-1', SITE))).toBeNull()
  })

  it('keeps the parts a concurrent release does not touch', async () => {
    await hold(THREE_PARTS)
    const held = await read()
    await Promise.all([
      releaseHeldValues('agent-a', 's-1', SITE, held, ['password']),
      releaseHeldValues('agent-a', 's-1', SITE, held, ['text:workspace']),
    ])
    expect(await freeValues()).toEqual({ 'text:company id': '42' })
  })

  it('settles concurrent claims on different parts without losing either', async () => {
    await hold(THREE_PARTS)
    const held = await read()
    const [first, second] = await Promise.all([
      claimHeldParts('agent-a', 's-1', SITE, held, ['password']),
      claimHeldParts('agent-a', 's-1', SITE, held, ['text:workspace']),
    ])
    expect(first && second).toBeTruthy()
    // One went in, the other's page refused it.
    await Promise.all([settleHeldClaim(first!, ['password']), settleHeldClaim(second!, [])])
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme', 'text:company id': '42' })
  })

  it('lets one fill take a part: a competing claim gets nothing', async () => {
    await hold({ password: 'pw-1' })
    const held = await read()
    const claims = await Promise.all([
      claimHeldParts('agent-a', 's-1', SITE, held, ['password']),
      claimHeldParts('agent-a', 's-1', SITE, held, ['password']),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    // Taken: not offered to anyone else while the fill runs.
    expect(await heldLoginFor('agent-a', 's-1', SITE)).toBeNull()
    expect(await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).toBeNull()
  })

  it('takes all of the parts asked for or none', async () => {
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    const held = await read()
    const workspace = await claimHeldParts('agent-a', 's-1', SITE, held, ['text:workspace'])
    expect(await claimHeldParts('agent-a', 's-1', SITE, held, ['password', 'text:workspace'])).toBeNull()
    expect(await freeValues()).toEqual({ password: 'pw-1' })
    await settleHeldClaim(workspace!, [])
    expect(await freeValues()).toEqual({ password: 'pw-1', 'text:workspace': 'acme' })
  })

  it('never claims or releases a value held after the read it was decided from', async () => {
    await hold({ password: 'old' })
    const stale = await read()
    await hold({ password: 'new' })
    expect(await claimHeldParts('agent-a', 's-1', SITE, stale, ['password'])).toBeNull()
    await releaseHeldValues('agent-a', 's-1', SITE, stale, ['password'])
    expect(await freeValues()).toEqual({ password: 'new' })
  })

  it('hands back what a refused fill did not use, and drops what may have gone in', async () => {
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    const refused = await claimHeldParts('agent-a', 's-1', SITE, await read(), ['password'])
    await settleHeldClaim(refused!, [])
    expect(await freeValues()).toEqual({ password: 'pw-1', 'text:workspace': 'acme' })

    // No answer at all: the page may hold it.
    const unanswered = await claimHeldParts('agent-a', 's-1', SITE, await read(), ['password'])
    await settleHeldClaim(unanswered!, Object.keys(unanswered!.values))
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme' })
    // Settling again changes nothing.
    await settleHeldClaim(unanswered!, [])
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme' })
  })

  it('drops a stale claim\'s parts rather than offering them again', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12) })
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    const held = await read()
    // The process that claimed it went away mid-fill.
    const abandoned = await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])
    vi.advanceTimersByTime(HELD_CLAIM_MS - 1)
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme' })
    expect(await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).toBeNull()

    vi.advanceTimersByTime(1)
    expect(await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).toBeNull()
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme' })
    // The next write removes it, and its process, back at last, hands back nothing.
    const workspace = await claimHeldParts('agent-a', 's-1', SITE, held, ['text:workspace'])
    await settleHeldClaim(workspace!, [])
    const stored = async () => (await appState().get(heldLoginKey('agent-a', 's-1', SITE)))?.value.parts
    const remaining = { 'text:workspace': { value: 'acme', id: held.ids['text:workspace'], claim: null } }
    expect(await stored()).toEqual(remaining)
    await settleHeldClaim(abandoned!, [])
    expect(await stored()).toEqual(remaining)
  })

  it('does not take back a part its own claim held past the deadline', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12) })
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    const slow = await claimHeldParts('agent-a', 's-1', SITE, await read(), ['password'])
    // The fill answers "not written", but only after the claim ran out.
    vi.advanceTimersByTime(HELD_CLAIM_MS)
    await settleHeldClaim(slow!, [])
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme' })
    expect(Object.keys((await appState().get(heldLoginKey('agent-a', 's-1', SITE)))!.value.parts)).toEqual(['text:workspace'])
  })

  it('keeps a hold for 30 minutes: using some of it does not renew the rest', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12) })
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    vi.advanceTimersByTime(20 * MINUTE)
    const claim = await claimHeldParts('agent-a', 's-1', SITE, await read(), ['password'])
    await settleHeldClaim(claim!, ['password'])
    vi.advanceTimersByTime(10 * MINUTE - 1)
    expect(await freeValues()).toEqual({ 'text:workspace': 'acme' })
    vi.advanceTimersByTime(1)
    expect(await freeValues()).toBeNull()
  })

  it('starts the 30 minutes again when the step is held again', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12) })
    await hold({ password: 'pw-1' })
    vi.advanceTimersByTime(20 * MINUTE)
    await hold({ password: 'pw-2' })
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(await freeValues()).toEqual({ password: 'pw-2' })
    vi.advanceTimersByTime(1)
    expect(await freeValues()).toBeNull()
  })

  it('keeps the identity for 30 minutes from the latest remember', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12) })
    await rememberSignInIdentity('agent-a', 's-1', SITE, 'octocat')
    vi.advanceTimersByTime(20 * MINUTE)
    await rememberSignInIdentity('agent-a', 's-1', SITE, 'octocat')
    vi.advanceTimersByTime(HOLD_MS - 1)
    expect(await recentSignInIdentity('agent-a', 's-1', SITE)).toBe('octocat')
    vi.advanceTimersByTime(1)
    expect(await recentSignInIdentity('agent-a', 's-1', SITE)).toBeNull()
  })

  it('forgets everything held on the site, even what a fill has taken, and keeps it forgotten', async () => {
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    const held = await read()
    const claim = await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])
    await forgetHeldLogin('agent-a', 's-1', SITE)
    expect(await heldLoginFor('agent-a', 's-1', SITE)).toBeNull()
    // The fill's page refused it: nothing comes back, and a re-hold carries nothing forgotten.
    await settleHeldClaim(claim!, [])
    expect(await holdLoginValues('agent-a', 's-1', SITE, login({}), { carry: held })).toBe(false)
    expect(await appState().get(heldLoginKey('agent-a', 's-1', SITE))).toBeNull()
  })

  it('carries an earlier read into a new hold only while it is still held', async () => {
    await hold({ password: 'pw-1', 'text:workspace': 'acme' })
    const held = await read()
    const claim = await claimHeldParts('agent-a', 's-1', SITE, held, ['text:workspace'])
    await settleHeldClaim(claim!, ['text:workspace'])
    expect(await holdLoginValues('agent-a', 's-1', SITE, login({ 'text:company id': '42' }, { save: null }), { carry: held })).toBe(true)
    expect(await freeValues()).toEqual({ password: 'pw-1', 'text:company id': '42' })
  })

  it('offers a held step only for its own account, and follows the latest identity', async () => {
    await hold({ password: 'pw-1' })
    expect(await heldLoginFor('agent-a', 's-1', SITE, 'hubot')).toBeNull()
    expect(await heldLoginFor('agent-a', 's-1', SITE, ' OCTOCAT ')).not.toBeNull()
    // A step held for no username goes with any.
    await hold({ password: 'pw-2' }, { username: null })
    expect((await heldLoginFor('agent-a', 's-1', SITE, 'hubot'))?.values).toEqual({ password: 'pw-2' })

    await rememberSignInIdentity('agent-a', 's-1', SITE, 'octocat')
    await rememberSignInIdentity('agent-a', 's-1', SITE, 'hubot')
    expect(await recentSignInIdentity('agent-a', 's-1', SITE)).toBe('hubot')
    // Not a username: a password manager entry can hold anything. Kept out, without failing the step.
    await rememberSignInIdentity('agent-a', 's-1', SITE, 'x'.repeat(5000))
    expect(await recentSignInIdentity('agent-a', 's-1', SITE)).toBe('hubot')
  })

  describe('when AppState does not answer', () => {
    it('fills once after a claim whose answer was lost', async () => {
      await hold({ password: 'pw-1' })
      const held = await read()
      const state = appState()
      const real = state.compareAndSet.bind(state)
      let lose = 1
      vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
        const written = await real(key, expected, value, options)
        // The claim lands; its answer does not arrive.
        if (lose-- > 0) throw new Error('AppState unavailable')
        return written
      })
      const claim = await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])
      expect(claim?.values).toEqual({ password: 'pw-1' })
      // One claim, the one this fill holds: no one else can take it.
      const record = (await appState().get(heldLoginKey('agent-a', 's-1', SITE)))!.value
      expect(record.parts.password.claim?.id).toBe(claim!.id)
      expect(await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).toBeNull()
      await settleHeldClaim(claim!, ['password'])
      expect(await appState().get(heldLoginKey('agent-a', 's-1', SITE))).toBeNull()
    })

    /**
     * The claim's write lands and its answer is lost; then the next `outage`
     * calls to AppState fail (Infinity: it stays down until restored).
     */
    function loseTheClaimAnswer(outage: number) {
      const state = appState()
      const real = { get: state.get.bind(state), compareAndSet: state.compareAndSet.bind(state) }
      let failing = 0
      let landed = false
      const fail = () => {
        failing--
        throw new Error('AppState unavailable')
      }
      const get = vi.spyOn(state, 'get').mockImplementation(async (key) => (failing > 0 ? fail() : await real.get(key)))
      const compareAndSet = vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
        if (failing > 0) fail()
        const written = await real.compareAndSet(key, expected, value, options)
        if (!landed && (value as HeldLoginRecord).parts.password?.claim) {
          landed = true
          failing = outage
          throw new Error('AppState unavailable')
        }
        return written
      })
      return () => {
        get.mockRestore()
        compareAndSet.mockRestore()
      }
    }

    it('hands back a claim it could not confirm, and fills nothing', async () => {
      await hold({ password: 'pw-1' })
      const held = await read()
      // The claim's two retries find AppState down; it is back for the hand-back.
      const restore = loseTheClaimAnswer(2)
      await expect(claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).rejects.toThrow('AppState unavailable')
      restore()
      expect(await freeValues()).toEqual({ password: 'pw-1' })
    })

    it('lets a claim it could neither confirm nor hand back lapse, and drops its parts', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 10, 5, 12) })
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      await hold({ password: 'pw-1' })
      const held = await read()
      const restore = loseTheClaimAnswer(Infinity)
      await expect(claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).rejects.toThrow('AppState unavailable')
      restore()
      expect(errors).toHaveBeenCalledOnce()
      expect(errors.mock.calls[0][0]).toContain('lapse')
      expect(JSON.stringify(errors.mock.calls)).not.toContain('pw-1')
      // Taken until the claim lapses; then gone, not offered again.
      expect(await heldLoginFor('agent-a', 's-1', SITE)).toBeNull()
      vi.advanceTimersByTime(HELD_CLAIM_MS)
      expect(await claimHeldParts('agent-a', 's-1', SITE, held, ['password'])).toBeNull()
      expect(await heldLoginFor('agent-a', 's-1', SITE)).toBeNull()
    })
  })
})
