/**
 * Custody of the app's own encryption keys. A KeyManager hands trusted host
 * crypto code (the Browser Vault's sealing) the key for a purpose; where the
 * key lives — the OS keychain on desktop, a deployment secret on a server, a
 * Worker secret binding on Cloudflare — is the implementation's business, not
 * the caller's. Callers never see a path or a platform secret API.
 *
 * Each entry point picks the implementation and installs it once, after the
 * database is open and before anything that seals or opens runs:
 * Electron main installs DesktopKeyManager (`src/main/keys/`), the web server
 * and the Vite dev server install ServerKeyManager. Importing this module does
 * nothing: no backend is chosen and no file is read until an entry point says
 * so. The installed manager serves one application (or tenant) scope for its
 * lifetime; nothing here is switched per request.
 */
import type { KeyObject } from 'crypto'

/** What a key is for. Each purpose has its own key: one never opens another's data. */
export type KeyPurpose = 'browser-vault'

export const KEY_PURPOSES: readonly KeyPurpose[] = ['browser-vault']

/** Where a purpose's key is held: for status and logs, never the key. */
export type KeyCustody =
  /** Wrapped by the OS (Keychain, DPAPI, libsecret/KWallet) through Electron safeStorage. */
  | 'os-secure-storage'
  /** A plaintext key file in the data directory: what every install used before KeyManager. */
  | 'plaintext-file'
  /** A secret the deployment provides (an environment variable or a mounted secret file). */
  | 'deployment-secret'
  /** Tests only. */
  | 'memory'

export type KeyUnavailableReason =
  /** Nothing installed a KeyManager: a boot-order bug in the entry point. */
  | 'not-installed'
  /** The OS secure store cannot be reached now (locked, or its backend changed). */
  | 'secure-storage-unavailable'
  /** Data is sealed under this purpose but no key for it is held here. */
  | 'missing'
  /** The stored key cannot be read as a key. */
  | 'corrupt'
  /** The key held here does not open the data sealed under this purpose. */
  | 'mismatch'
  /** Two different keys are held for one purpose. */
  | 'conflict'
  /** The deployment's key configuration is invalid. */
  | 'misconfigured'
  /** The key could not be stored or read for another reason (I/O). */
  | 'io'

/**
 * A key the manager cannot hand out. `message` is for logs (it may name files
 * and settings, never key material); `userMessage` is what a person using the
 * app is told, and says what to do.
 */
export class KeyUnavailableError extends Error {
  constructor(
    readonly purpose: KeyPurpose,
    readonly reason: KeyUnavailableReason,
    message: string,
    readonly userMessage: string = message,
  ) {
    super(message)
    this.name = 'KeyUnavailableError'
  }
}

/**
 * What the data sealed under a purpose says about a candidate key. Each
 * purpose's owner supplies one (the vault tries the latest sealed values), so
 * the manager can verify a key against real ciphertext before it migrates,
 * creates or uses one, without knowing the tables.
 */
export type KeyProbeResult = 'opens' | 'does-not-open' | 'nothing-sealed'
export type KeyProbe = (key: KeyObject) => Promise<KeyProbeResult>
export type KeyProbes = Readonly<Record<KeyPurpose, KeyProbe>>

export interface KeyManager {
  /** Which implementation this is, for logs ('desktop', 'server', …). */
  readonly name: string
  /**
   * Prepare custody: check the backend and finish a pending migration (a
   * legacy key file to move into secure storage). Resolves even when a key is
   * unavailable — `key()` reports that, with the reason — so a locked
   * keychain degrades the vault rather than stopping the app.
   */
  initialize(): Promise<void>
  /**
   * The purpose's 256-bit key, for AES-256-GCM. Made on first use where the
   * implementation may make one and nothing is sealed yet; never made over
   * sealed data. Rejects with KeyUnavailableError.
   */
  key(purpose: KeyPurpose): Promise<KeyObject>
}

let installed: KeyManager | null = null
let installing: Promise<KeyManager> | null = null

/**
 * Initialize a manager and make it the app's. The entry point awaits this
 * before anything seals or opens. A second install while one is in place is a
 * boot bug (the scope's custody would change underneath sealed data), so it
 * throws; tests uninstall between cases.
 */
export async function installKeyManager(manager: KeyManager): Promise<KeyManager> {
  if (installed || installing) throw new Error('A KeyManager is already installed for this process')
  installing = manager.initialize().then(() => manager)
  try {
    installed = await installing
    return installed
  } finally {
    installing = null
  }
}

/**
 * The installed manager, installing the one `create` makes if there is none:
 * for an entry point that may run its boot step more than once at a time (the
 * Vite dev server checks per request). Concurrent callers share one install.
 */
export function ensureKeyManager(create: () => KeyManager): Promise<KeyManager> {
  if (installed) return Promise.resolve(installed)
  if (installing) return installing
  return installKeyManager(create())
}

/**
 * The installed manager. Before an entry point installed one this throws a
 * KeyUnavailableError naming the boot step, rather than choosing a backend
 * itself with whatever environment happens to be set.
 */
export function keyManager(): KeyManager {
  if (!installed) {
    throw new KeyUnavailableError(
      'browser-vault',
      'not-installed',
      'No KeyManager is installed. The entry point must await installKeyManager() before anything seals or opens.',
      'The Browser Vault is still starting. Try again in a moment.',
    )
  }
  return installed
}

/** The installed manager's key for a purpose: what crypto code calls. */
export function keyFor(purpose: KeyPurpose): Promise<KeyObject> {
  try {
    return keyManager().key(purpose)
  } catch (error) {
    return Promise.reject(error instanceof KeyUnavailableError && error.purpose !== purpose
      ? new KeyUnavailableError(purpose, error.reason, error.message, error.userMessage)
      : error)
  }
}

export function isKeyManagerInstalled(): boolean {
  return installed !== null
}

/** Forget the installed manager (tests, and a dev server re-instantiating modules). */
export function uninstallKeyManager(): void {
  installed = null
  installing = null
}
