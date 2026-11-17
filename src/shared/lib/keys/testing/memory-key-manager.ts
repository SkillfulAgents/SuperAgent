import crypto, { type KeyObject } from 'crypto'
import { installKeyManager, KeyUnavailableError, uninstallKeyManager, type KeyManager, type KeyPurpose } from '../key-manager'

/**
 * Tests' key custody: a random key per purpose, in memory. `replaceKey`
 * stands in for a lost key (a restored database on another machine), and
 * `makeUnavailable` for a locked keychain.
 */
export class MemoryKeyManager implements KeyManager {
  readonly name = 'memory'
  private readonly keys = new Map<KeyPurpose, KeyObject>()
  private unavailable: KeyUnavailableError | null = null

  async initialize(): Promise<void> {}

  async key(purpose: KeyPurpose): Promise<KeyObject> {
    if (this.unavailable) throw this.unavailable
    let key = this.keys.get(purpose)
    if (!key) {
      key = crypto.createSecretKey(crypto.randomBytes(32))
      this.keys.set(purpose, key)
    }
    return key
  }

  replaceKey(purpose: KeyPurpose, bytes: Buffer = crypto.randomBytes(32)): void {
    this.keys.set(purpose, crypto.createSecretKey(bytes))
  }

  makeUnavailable(error: KeyUnavailableError | null): void {
    this.unavailable = error
  }
}

/** Install a fresh in-memory KeyManager (uninstalling any other); pair with `uninstallKeyManager()` after. */
export async function installTestKeyManager(): Promise<MemoryKeyManager> {
  uninstallKeyManager()
  const manager = new MemoryKeyManager()
  await installKeyManager(manager)
  return manager
}

export { uninstallKeyManager }
