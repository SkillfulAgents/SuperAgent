import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState, closeAppState, initializeAppState } from './app-state'
import { digestKeyPart } from './definitions'
import { createLocalAppState, LocalAppStateBackend } from './local-app-state'
import { defineLockout, type LockoutPolicy, type UnlockedStatus } from './lockout'

const T0 = Date.parse('2026-11-04T12:00:00Z')
const LOCK_MS = 30 * 60_000
const policy: LockoutPolicy = { threshold: 3, lockMs: LOCK_MS }

const lockouts = defineLockout({ name: 'test:lockout' })
const account = lockouts.key(digestKeyPart('person@example.com'))

beforeEach(() => {
  // The lockout and the default LocalAppState backend both read Date.now().
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

async function failures(): Promise<number> {
  return (await appState().get(account))?.value.failures ?? 0
}

async function fail(times: number): Promise<void> {
  for (let i = 0; i < times; i++) await lockouts.failed(account, policy)
}

async function unlocked(checkPolicy: LockoutPolicy = policy): Promise<UnlockedStatus> {
  const status = await lockouts.check(account, checkPolicy)
  if (status.locked) throw new Error('expected the account to be unlocked')
  return status
}

/** Runs `intrude` once, just before the next call of `operation` reaches the store. */
function intrudeBefore(operation: 'consume' | 'compareAndSet', intrude: () => Promise<unknown>): void {
  const state = appState()
  const original = state[operation].bind(state) as (...args: unknown[]) => Promise<unknown>
  vi.spyOn(state, operation).mockImplementationOnce((async (...args: unknown[]) => {
    await intrude()
    return original(...args)
  }) as never)
}

describe('defineLockout', () => {
  it('counts failures and locks at the threshold for lockMs', async () => {
    await fail(2)
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: false, failures: 2 })

    expect(await lockouts.failed(account, policy)).toMatchObject({ failures: 3, lockedUntil: T0 + LOCK_MS })
    expect(await lockouts.check(account, policy)).toEqual({ locked: true, failures: 3, lockedUntil: T0 + LOCK_MS })

    vi.setSystemTime(T0 + LOCK_MS - 1)
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: true })
  })

  it('clears a lock that has run out, so the account counts from zero again', async () => {
    await fail(3)
    vi.setSystemTime(T0 + LOCK_MS)

    expect(await lockouts.check(account, policy)).toEqual({ locked: false, failures: 0, observed: null })
    expect(await appState().get(account)).toBeNull()
    await fail(2)
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: false, failures: 2 })
  })

  it('extends the lock with each failure at or over the threshold', async () => {
    await fail(3)
    vi.setSystemTime(T0 + 10_000)
    expect(await lockouts.failed(account, policy)).toMatchObject({ failures: 4, lockedUntil: T0 + 10_000 + LOCK_MS })
  })

  it('keeps failures below the threshold with no expiry', async () => {
    await fail(2)
    vi.setSystemTime(T0 + 365 * 24 * 60 * 60_000)

    expect(await appState().get(account)).toMatchObject({ value: { failures: 2 }, expiresAt: null })
    await fail(1)
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: true })
  })

  it('decides with the threshold of each call', async () => {
    await fail(3)
    // Raised past the count: no longer locked, and the failures still count toward the new threshold.
    expect(await lockouts.check(account, { threshold: 5, lockMs: LOCK_MS })).toMatchObject({ locked: false, failures: 3 })
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: true })
  })

  it('counts every competing failure', async () => {
    const many: LockoutPolicy = { threshold: 50, lockMs: LOCK_MS }
    await Promise.all(Array.from({ length: 40 }, () => lockouts.failed(account, many)))

    expect(await failures()).toBe(40)
    expect(await lockouts.check(account, many)).toMatchObject({ locked: false })
    await Promise.all(Array.from({ length: 10 }, () => lockouts.failed(account, many)))
    expect(await lockouts.check(account, many)).toMatchObject({ locked: true, failures: 50 })
  })

  it('clears the failures a success was checked against', async () => {
    await fail(2)
    const status = await unlocked()
    await lockouts.succeeded(account, status)
    expect(await appState().get(account)).toBeNull()
  })

  it('keeps a failure counted between the check and the success', async () => {
    await fail(1)
    const status = await unlocked()
    // A wrong password from elsewhere lands while this sign-in is being checked.
    intrudeBefore('consume', () => lockouts.failed(account, policy))

    await lockouts.succeeded(account, status)

    expect(await failures()).toBe(1)
    await fail(2)
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: true })
  })

  it('keeps a failure that lands after two successes saw the same record', async () => {
    const roomy: LockoutPolicy = { threshold: 10, lockMs: LOCK_MS }
    for (let i = 0; i < 3; i++) await lockouts.failed(account, roomy)
    const first = await unlocked(roomy)
    const second = await unlocked(roomy)
    expect(first.observed?.failures).toBe(3)
    expect(second.observed).toEqual(first.observed)
    // A wrong password from elsewhere lands after both checks.
    await lockouts.failed(account, roomy)

    // The first takes away the 3 it saw and keeps the 1; the second, holding the same observation, must not clear that 1.
    await lockouts.succeeded(account, first)
    expect(await failures()).toBe(1)
    await lockouts.succeeded(account, second)

    expect(await failures()).toBe(1)
  })

  it('keeps every failure when the success was checked with none counted', async () => {
    const status = await unlocked()
    await fail(2)
    await lockouts.succeeded(account, status)
    expect(await failures()).toBe(2)
  })

  it('leaves a run of failures that started after the record it saw was cleared', async () => {
    await fail(2)
    const stale = await unlocked()
    // Another success clears the record, and new failures start a new run.
    await lockouts.succeeded(account, await unlocked())
    await fail(2)

    await lockouts.succeeded(account, stale)

    expect(await failures()).toBe(2)
  })

  it('counts a failure that races a success on a fresh record', async () => {
    await fail(2)
    const status = await unlocked()
    // The success clears the record between the failure's read and its write.
    intrudeBefore('compareAndSet', () => lockouts.succeeded(account, status))

    await lockouts.failed(account, policy)

    expect(await failures()).toBe(1)
  })

  it('does not clear a run-out lock that a failure renewed meanwhile', async () => {
    await fail(3)
    vi.setSystemTime(T0 + LOCK_MS)
    // A failure that was let through before the lock was set lands between the check's read and its clear.
    intrudeBefore('consume', () => lockouts.failed(account, policy))

    expect(await lockouts.check(account, policy)).toEqual({
      locked: true,
      failures: 4,
      lockedUntil: T0 + 2 * LOCK_MS,
    })
  })

  it('counts each tenant on its own', async () => {
    const backend = new LocalAppStateBackend()
    await closeAppState()
    await initializeAppState(createLocalAppState({ scope: { deploymentId: 'cloud', tenantId: 'org-a' }, backend }))
    await fail(3)
    expect(await lockouts.check(account, policy)).toMatchObject({ locked: true })

    await closeAppState()
    await initializeAppState(createLocalAppState({ scope: { deploymentId: 'cloud', tenantId: 'org-b' }, backend }))
    expect(await lockouts.check(account, policy)).toEqual({ locked: false, failures: 0, observed: null })
  })
})
