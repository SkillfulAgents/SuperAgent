import crypto from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureKeyManager,
  installKeyManager,
  isKeyManagerInstalled,
  keyFor,
  KeyUnavailableError,
  uninstallKeyManager,
  type KeyManager,
} from './key-manager'
import { MemoryKeyManager } from './testing/memory-key-manager'

afterEach(() => {
  uninstallKeyManager()
})

describe('the installed KeyManager', () => {
  it('is an explicit boot step: asking for a key before it reports the step, not a key from somewhere', async () => {
    expect(isKeyManagerInstalled()).toBe(false)
    await expect(keyFor('browser-vault')).rejects.toMatchObject({ name: 'KeyUnavailableError', reason: 'not-installed' })
  })

  it('is initialized before it is installed', async () => {
    const order: string[] = []
    let release!: () => void
    const manager: KeyManager = {
      name: 'slow',
      initialize: () => new Promise<void>((resolve) => {
        order.push('initialize')
        release = () => {
          order.push('initialized')
          resolve()
        }
      }),
      key: async () => crypto.createSecretKey(crypto.randomBytes(32)),
    }
    const installing = installKeyManager(manager)
    await Promise.resolve()
    // Not yet usable while it initializes.
    expect(isKeyManagerInstalled()).toBe(false)
    await expect(keyFor('browser-vault')).rejects.toMatchObject({ reason: 'not-installed' })
    release()
    await installing
    expect(order).toEqual(['initialize', 'initialized'])
    await expect(keyFor('browser-vault')).resolves.toBeDefined()
  })

  it('is installed once per process: a second install is a boot bug', async () => {
    await installKeyManager(new MemoryKeyManager())
    await expect(installKeyManager(new MemoryKeyManager())).rejects.toThrow('already installed')
  })

  it('installs one manager for concurrent boot steps (the dev server checks per request)', async () => {
    const create = vi.fn(() => new MemoryKeyManager())
    const managers = await Promise.all([ensureKeyManager(create), ensureKeyManager(create), ensureKeyManager(create)])
    expect(create).toHaveBeenCalledTimes(1)
    expect(new Set(managers).size).toBe(1)
    expect(await ensureKeyManager(create)).toBe(managers[0])
  })

  it('leaves nothing installed when initialization fails, so a retry can install', async () => {
    const failing: KeyManager = { name: 'failing', initialize: async () => { throw new Error('boom') }, key: async () => { throw new Error('unused') } }
    await expect(installKeyManager(failing)).rejects.toThrow('boom')
    expect(isKeyManagerInstalled()).toBe(false)
    await installKeyManager(new MemoryKeyManager())
    expect(isKeyManagerInstalled()).toBe(true)
  })

  it('passes a manager\'s KeyUnavailableError through with its reason and what to tell the user', async () => {
    const manager = new MemoryKeyManager()
    manager.makeUnavailable(new KeyUnavailableError('browser-vault', 'secure-storage-unavailable', 'log detail', 'Unlock your keychain.'))
    await installKeyManager(manager)
    await expect(keyFor('browser-vault')).rejects.toMatchObject({ reason: 'secure-storage-unavailable', userMessage: 'Unlock your keychain.' })
  })
})
