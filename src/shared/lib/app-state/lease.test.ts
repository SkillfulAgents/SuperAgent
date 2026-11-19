import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from './app-state'
import { defineLease, LeaseLostError, LeaseWaitTimeoutError, type LeaseHolding } from './lease'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const TTL_MS = 30_000

const claims = defineLease({ name: 'test:claim', ttlMs: TTL_MS })
const key = claims.key('integration', 'version-1')

// One clock, as on one machine: the backend's expiry and the holder's own
// deadline both read Date.now(), which these tests move by hand. Timers stay
// real unless a test fakes them too.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

/** The next compareAndSet commits in the backend, and its answer comes back `ms` later. */
function answerCompareAndSetAfter(ms: number): void {
  const state = appState()
  const compareAndSet = state.compareAndSet.bind(state)
  vi.spyOn(state, 'compareAndSet').mockImplementationOnce(async (written, expected, value, options) => {
    const answer = await compareAndSet(written, expected, value, options)
    advance(ms)
    return answer
  })
}

describe('defineLease', () => {
  it('lets exactly one of competing acquisitions win, each as a fresh owner', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claims.acquire(key)))
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ key, heldUntil: T0 + TTL_MS })
    expect((await appState().get(key))?.value).toEqual({ owner: winners[0]!.owner })

    expect(await claims.release(winners[0]!)).toBe(true)
    const next = await claims.acquire(key)
    expect(next?.owner).toBeDefined()
    expect(next?.owner).not.toBe(winners[0]!.owner)
  })

  it('renews only while the lease is still the holder\'s', async () => {
    const first = (await claims.acquire(key))!
    advance(20_000)
    const renewed = (await claims.renew(first))!
    expect(renewed).toMatchObject({ owner: first.owner, heldUntil: T0 + 20_000 + TTL_MS })
    expect(renewed.revision).not.toBe(first.revision)
    // The renewal moved the end: past the original one the lease still holds.
    advance(20_000)
    expect(await claims.acquire(key)).toBeNull()
    // The revision it renewed from is spent.
    expect(await claims.renew(first)).toBeNull()

    advance(TTL_MS)
    // Lapsed: renewal is refused, and stays refused once another owner has the key.
    expect(await claims.renew(renewed)).toBeNull()
    const successor = (await claims.acquire(key))!
    expect(await claims.renew(renewed)).toBeNull()
    expect((await appState().get(key))?.value).toEqual({ owner: successor.owner })
  })

  it('does not let a stale owner release a successor\'s lease', async () => {
    const stale = (await claims.acquire(key))!
    advance(TTL_MS)
    const successor = (await claims.acquire(key))!
    expect(await claims.release(stale)).toBe(false)
    expect(await claims.acquire(key)).toBeNull()
    expect((await appState().get(key))?.value).toEqual({ owner: successor.owner })
    expect(await claims.release(successor)).toBe(true)
    expect(await claims.acquire(key)).not.toBeNull()
  })

  it('refuses a key of another namespace and a renewal schedule that cannot keep up', async () => {
    const other = defineLease({ name: 'test:other-claim', ttlMs: TTL_MS })
    await expect(claims.acquire(other.key('integration'))).rejects.toThrow(TypeError)
    expect(() => defineLease({ name: 'test:slow', ttlMs: 1_000, renewEveryMs: 1_000 })).toThrow(RangeError)
  })

  describe('answers that come back too late', () => {
    it('does not count an acquisition answered once the lease would have run out, and frees the key', async () => {
      const state = appState()
      const insertIfAbsent = state.insertIfAbsent.bind(state)
      vi.spyOn(state, 'insertIfAbsent').mockImplementationOnce(async (written, value, options) => {
        // The request reaches the backend late and commits there; its answer
        // comes back when a lease sent at T0 would have run out.
        advance(5_000)
        const answer = await insertIfAbsent(written, value, options)
        advance(TTL_MS - 5_000)
        return answer
      })
      expect(await claims.acquire(key)).toBeNull()
      // The write lasts 30 s from its commit, so it was still there: released.
      expect(await claims.acquire(key)).not.toBeNull()
    })

    it('does not count a renewal answered once the lease would have run out', async () => {
      const held = (await claims.acquire(key))!
      answerCompareAndSetAfter(TTL_MS)
      expect(await claims.renew(held)).toBeNull()
    })

    it('fails confirm() and aborts the holding\'s signal on a renewal answered too late', async () => {
      const held = (await claims.acquire(key))!
      await expect(claims.hold(held, async holding => {
        answerCompareAndSetAfter(TTL_MS)
        await expect(holding.confirm()).rejects.toBeInstanceOf(LeaseLostError)
        expect(holding.signal.aborted).toBe(true)
        expect(holding.signal.reason).toBeInstanceOf(LeaseLostError)
        return 'done'
      })).resolves.toBe('done')
    })

    it('resolves confirm({ minRemainingMs }) only with that much of the lease left, and gives the lease up otherwise', async () => {
      const held = (await claims.acquire(key))!
      await claims.hold(held, async holding => {
        // Answered 20 s after it was sent: 10 s of the renewed lease are left.
        answerCompareAndSetAfter(20_000)
        await holding.confirm({ minRemainingMs: 10_000 })
        expect(holding.signal.aborted).toBe(false)

        answerCompareAndSetAfter(20_000)
        await expect(holding.confirm({ minRemainingMs: 10_001 })).rejects.toBeInstanceOf(LeaseLostError)
        expect(holding.signal.aborted).toBe(true)
        // Released at once, not when the work settles.
        expect(await claims.acquire(key)).not.toBeNull()
      })
    })
  })

  describe('hold', () => {
    it('renews while the work runs, then releases', async () => {
      vi.useRealTimers()
      vi.useFakeTimers({ now: T0 })
      const held = (await claims.acquire(key))!
      let finish!: () => void
      const running = claims.hold(held, () => new Promise<string>(resolve => { finish = () => resolve('done') }))
      // Three lease lifetimes: only the renewals keep it.
      await vi.advanceTimersByTimeAsync(3 * TTL_MS)
      expect(await claims.acquire(key)).toBeNull()
      finish()
      await expect(running).resolves.toBe('done')
      expect(await claims.acquire(key)).not.toBeNull()
    })

    it('aborts the work\'s signal once the lease is lost, and leaves the successor\'s alone', async () => {
      vi.useRealTimers()
      vi.useFakeTimers({ now: T0 })
      const held = (await claims.acquire(key))!
      let holding!: LeaseHolding
      const running = claims.hold(held, async given => {
        holding = given
        await new Promise(resolve => given.signal.addEventListener('abort', resolve))
        await given.confirm()
      })
      const outcome = expect(running).rejects.toBeInstanceOf(LeaseLostError)
      // The holder stalls past its lease without renewing (no timer ran), and
      // another owner takes the key.
      vi.setSystemTime(T0 + TTL_MS + 1)
      const successor = (await claims.acquire(key))!
      expect(holding.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(claims.renewEveryMs)
      expect(holding.signal.aborted).toBe(true)
      expect(holding.signal.reason).toBeInstanceOf(LeaseLostError)
      await outcome
      expect((await appState().get(key))?.value).toEqual({ owner: successor.owner })
    })

    it('aborts the work\'s signal when the lease runs out with a renewal still unanswered', async () => {
      vi.useRealTimers()
      vi.useFakeTimers({ now: T0 })
      const held = (await claims.acquire(key))!
      // The renewal hangs: no answer says the lease was lost.
      let answer!: () => void
      vi.spyOn(appState(), 'compareAndSet').mockImplementation(() => new Promise(resolve => {
        answer = () => resolve({ ok: false, current: null })
      }))
      let holding!: LeaseHolding
      const running = claims.hold(held, async given => {
        holding = given
        await new Promise(resolve => given.signal.addEventListener('abort', resolve))
        return 'stopped'
      })
      await vi.advanceTimersByTimeAsync(TTL_MS - 1)
      expect(holding.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(holding.signal.reason).toBeInstanceOf(LeaseLostError)
      answer()
      await expect(running).resolves.toBe('stopped')
    })

    it('confirms a lease that is still held, however many confirmations overlap a renewal', async () => {
      vi.useRealTimers()
      vi.useFakeTimers({ now: T0 })
      const held = (await claims.acquire(key))!
      await claims.hold(held, async holding => {
        // Each renewal writes a new revision; confirmations racing the timer's
        // renewal from one revision would see a false loss.
        const tick = vi.advanceTimersByTimeAsync(claims.renewEveryMs)
        await Promise.all([holding.confirm(), holding.confirm(), holding.confirm(), tick])
        expect(holding.signal.aborted).toBe(false)
      })
    })

    it('confirm() refuses once the lease has lapsed', async () => {
      const held = (await claims.acquire(key))!
      await expect(claims.hold(held, async holding => {
        advance(TTL_MS)
        await holding.confirm()
        return 'wrote'
      })).rejects.toBeInstanceOf(LeaseLostError)
    })

    it('confirm() asks the backend: it refuses once another owner has the key, with time left by this process\'s clock', async () => {
      const held = (await claims.acquire(key))!
      await expect(claims.hold(held, async holding => {
        // The backend dropped the record early (its clock runs ahead, or it
        // lost it), and another owner took the key.
        await appState().delete(key)
        expect(await claims.acquire(key)).not.toBeNull()
        await holding.confirm()
        return 'wrote'
      })).rejects.toBeInstanceOf(LeaseLostError)
    })
  })

  describe('acquireWhenFree', () => {
    beforeEach(() => { vi.useRealTimers() })

    it('waits for another owner\'s release, then takes the lease', async () => {
      const other = (await claims.acquire(key))!
      const waiting = claims.acquireWhenFree(key, { timeoutMs: 5_000 })
      await new Promise(resolve => setTimeout(resolve, 120))
      await claims.release(other)
      const turn = await waiting
      expect(turn.acquired).toBe(true)
      expect(turn.acquired && turn.lease.owner).not.toBe(other.owner)
    })

    it('ends the wait without the lease when whileWaiting has a result', async () => {
      await claims.acquire(key)
      const checks = vi.fn(async () => (checks.mock.calls.length >= 2 ? 'done elsewhere' : undefined))
      await expect(claims.acquireWhenFree(key, { timeoutMs: 5_000, whileWaiting: checks }))
        .resolves.toEqual({ acquired: false, result: 'done elsewhere' })
      expect(checks).toHaveBeenCalledTimes(2)
    })

    it('gives up after timeoutMs while another owner holds the lease', async () => {
      await claims.acquire(key)
      await expect(claims.acquireWhenFree(key, { timeoutMs: 150 })).rejects.toBeInstanceOf(LeaseWaitTimeoutError)
    })
  })
})
