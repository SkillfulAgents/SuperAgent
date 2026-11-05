import { afterEach, describe, expect, it, vi } from 'vitest'
import { appState, closeAppState, initializeAppState } from './app-state'
import { createLocalAppState, LocalAppStateBackend } from './local-app-state'
import { defineLease, LeaseLostError, LeaseWaitTimeoutError, type LeaseHolding } from './lease'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const TTL_MS = 30_000

const claims = defineLease({ name: 'test:claim', ttlMs: TTL_MS })
const key = claims.key('integration', 'version-1')

let clock = T0
/** A backend on a clock the test moves; nothing here runs timers against it. */
async function installManualClock(): Promise<void> {
  clock = T0
  await closeAppState()
  await initializeAppState(createLocalAppState({ backend: new LocalAppStateBackend({ now: () => clock }) }))
}

afterEach(() => { vi.useRealTimers() })

describe('defineLease', () => {
  it('lets exactly one of competing acquisitions win, each as a fresh owner', async () => {
    await installManualClock()
    const results = await Promise.all(Array.from({ length: 8 }, () => claims.acquire(key)))
    const winners = results.filter(result => result !== null)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ key, expiresAt: T0 + TTL_MS })
    expect((await appState().get(key))?.value).toEqual({ owner: winners[0]!.owner })

    expect(await claims.release(winners[0]!)).toBe(true)
    const next = await claims.acquire(key)
    expect(next?.owner).toBeDefined()
    expect(next?.owner).not.toBe(winners[0]!.owner)
  })

  it('renews only while the lease is still the holder\'s', async () => {
    await installManualClock()
    const first = (await claims.acquire(key))!
    clock += 20_000
    const renewed = (await claims.renew(first))!
    expect(renewed).toMatchObject({ owner: first.owner, expiresAt: clock + TTL_MS })
    expect(renewed.revision).not.toBe(first.revision)
    // The renewal moved the end: past the original one the lease still holds.
    clock += 20_000
    expect(await claims.acquire(key)).toBeNull()
    // The revision it renewed from is spent.
    expect(await claims.renew(first)).toBeNull()

    clock += TTL_MS
    // Lapsed: renewal is refused, and stays refused once another owner has the key.
    expect(await claims.renew(renewed)).toBeNull()
    const successor = (await claims.acquire(key))!
    expect(await claims.renew(renewed)).toBeNull()
    expect((await appState().get(key))?.value).toEqual({ owner: successor.owner })
  })

  it('does not let a stale owner release a successor\'s lease', async () => {
    await installManualClock()
    const stale = (await claims.acquire(key))!
    clock += TTL_MS
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

  describe('hold', () => {
    it('renews while the work runs, then releases', async () => {
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

    it('confirms a lease that is still held, however many confirmations overlap a renewal', async () => {
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
      await installManualClock()
      const held = (await claims.acquire(key))!
      await expect(claims.hold(held, async holding => {
        clock += TTL_MS
        await holding.confirm()
        return 'wrote'
      })).rejects.toBeInstanceOf(LeaseLostError)
    })
  })

  describe('acquireWhenFree', () => {
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
