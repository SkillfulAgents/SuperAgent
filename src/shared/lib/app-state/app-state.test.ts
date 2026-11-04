import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(async () => {
  await closeAppState()
})

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
