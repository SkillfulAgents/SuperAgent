import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { appState, closeAppState, initializeAppState, initializeLocalAppState, isAppStateInitialized } from './app-state'
import { defineNamespace } from './definitions'
import { createLocalAppState } from './local-app-state'

const flows = defineNamespace({
  name: 'test:flows',
  consistency: 'strong',
  schema: z.string(),
  expiry: { ttlMs: null, onUpdate: 'keep' },
})

// The shared test setup installs one per test; these tests start without it.
beforeEach(async () => {
  await closeAppState()
})

afterEach(async () => {
  await closeAppState()
})

/** A backend whose connection the test completes. */
function connecting() {
  let connect!: () => void
  const connected = new Promise<void>((resolve) => (connect = resolve))
  const state = createLocalAppState()
  const close = vi.spyOn(state, 'close')
  return { state, close, connect, ready: connected.then(() => state) }
}

describe('the process AppState', () => {
  it('throws on use before the entry point initialized it', () => {
    expect(isAppStateInitialized()).toBe(false)
    expect(() => appState()).toThrow('The entry point must await initializeAppState()')
  })

  it('serves the installed instance once initialized', async () => {
    const installed = await initializeLocalAppState()
    expect(appState()).toBe(installed)
    await appState().set(flows.key('f1'), 'pending')
    expect((await appState().get(flows.key('f1')))?.value).toBe('pending')
  })

  it('waits for an implementation that connects first', async () => {
    let connect!: () => void
    const connected = new Promise<void>((resolve) => (connect = resolve))
    const state = createLocalAppState()
    const initializing = initializeAppState(connected.then(() => state))

    expect(isAppStateInitialized()).toBe(false)
    connect()
    await initializing
    expect(appState()).toBe(state)
  })

  it('installs a ready instance before returning, so concurrent check-then-initialize calls cannot race', async () => {
    const initializeOnce = async () => {
      if (!isAppStateInitialized()) await initializeLocalAppState()
    }
    await Promise.all([initializeOnce(), initializeOnce()])
    expect(isAppStateInitialized()).toBe(true)
  })

  it('is initialized once: a second initialization is refused, also while the first is connecting', async () => {
    let connect!: () => void
    const connected = new Promise<void>((resolve) => (connect = resolve))
    const first = initializeAppState(connected.then(() => createLocalAppState()))
    await expect(initializeLocalAppState()).rejects.toThrow('already initialized')
    connect()
    await first
    await expect(initializeLocalAppState()).rejects.toThrow('already initialized')
  })

  it('cancels an initialization still connecting when closed, and closes what it connected', async () => {
    const backend = connecting()
    const initializing = initializeAppState(backend.ready)
    const rejected = expect(initializing).rejects.toThrow('closed while it was initializing')

    let closed = false
    const closing = closeAppState().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)

    backend.connect()
    await closing
    await rejected
    expect(backend.close).toHaveBeenCalledOnce()
    expect(isAppStateInitialized()).toBe(false)
    expect(() => appState()).toThrow('not initialized')

    const next = await initializeLocalAppState()
    expect(appState()).toBe(next)
  })

  it('serves the same instance to another copy of this module, as after vi.resetModules()', async () => {
    const installed = await initializeLocalAppState()
    vi.resetModules()
    const reloaded = await import('./app-state')
    expect(reloaded.appState()).toBe(installed)
  })

  it('throws again once closed, and a test can install a fresh one with no state left over', async () => {
    const first = await initializeLocalAppState()
    await first.set(flows.key('f1'), 'pending')
    await closeAppState()
    expect(() => appState()).toThrow('not initialized')
    await expect(first.get(flows.key('f1'))).rejects.toThrow('closed')

    await initializeLocalAppState()
    expect(await appState().get(flows.key('f1'))).toBeNull()
  })
})
