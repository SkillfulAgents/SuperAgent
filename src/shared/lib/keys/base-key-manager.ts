import type { KeyObject } from 'crypto'
import { captureException } from '@shared/lib/error-reporting'
import {
  KEY_PURPOSES,
  KeyUnavailableError,
  type KeyCustody,
  type KeyManager,
  type KeyProbes,
  type KeyPurpose,
} from './key-manager'
import { toKeyObject } from './key-material'

export interface KeyLog {
  info(message: string): void
  warn(message: string): void
}

export interface ResolvedKey {
  bytes: Buffer
  custody: KeyCustody
}

/**
 * What the file-backed managers share: one resolution per purpose at a time
 * (callers racing on a fresh install agree on one key), the key kept for the
 * manager's lifetime once resolved, and a failure retried on the next call
 * rather than remembered (an unlocked keychain or a fixed file is picked up).
 */
export abstract class BaseKeyManager implements KeyManager {
  abstract readonly name: string
  private readonly resolved = new Map<KeyPurpose, KeyObject>()
  private readonly inFlight = new Map<KeyPurpose, Promise<KeyObject | null>>()
  private readonly reported = new Set<string>()

  protected constructor(
    protected readonly probes: KeyProbes,
    protected readonly log: KeyLog,
  ) {}

  /**
   * Find the purpose's key where this implementation keeps it, migrating or
   * verifying on the way. With `create`, make one when none is held and
   * nothing is sealed; without, null for none. Throws KeyUnavailableError.
   */
  protected abstract resolve(purpose: KeyPurpose, options: { create: boolean }): Promise<ResolvedKey | null>

  async initialize(): Promise<void> {
    for (const purpose of KEY_PURPOSES) {
      try {
        await this.load(purpose, false)
      } catch {
        // Reported by load(); the app runs, key() tries again and says why.
      }
    }
  }

  async key(purpose: KeyPurpose): Promise<KeyObject> {
    const key = await this.load(purpose, true)
    if (!key) throw new KeyUnavailableError(purpose, 'missing', `No ${purpose} key was made`)
    return key
  }

  /** The purpose's key if one is held, without making one. */
  protected existingKey(purpose: KeyPurpose): Promise<KeyObject | null> {
    return this.load(purpose, false)
  }

  private load(purpose: KeyPurpose, create: boolean): Promise<KeyObject | null> {
    const cached = this.resolved.get(purpose)
    if (cached) return Promise.resolve(cached)
    const pending = this.inFlight.get(purpose)
    // A lookup without `create` in flight may end with none: wait, then make one.
    if (pending) return create ? pending.then((key) => key ?? this.load(purpose, true)) : pending
    const attempt = this.resolve(purpose, { create })
      .then((found) => {
        if (!found) return null
        const key = toKeyObject(found.bytes)
        found.bytes.fill(0)
        this.resolved.set(purpose, key)
        this.log.info(`[keys] ${this.name}: the ${purpose} key is held in ${describeCustody(found.custody)}`)
        return key
      }, (error: unknown) => {
        this.report(purpose, error)
        throw error
      })
      .finally(() => {
        if (this.inFlight.get(purpose) === attempt) this.inFlight.delete(purpose)
      })
    this.inFlight.set(purpose, attempt)
    return attempt
  }

  /** Each distinct failure once per manager: logged, and sent to error reporting without key material. */
  private report(purpose: KeyPurpose, error: unknown): void {
    const reason = error instanceof KeyUnavailableError ? error.reason : 'unexpected'
    const message = error instanceof Error ? error.message : String(error)
    const id = `${purpose}:${reason}:${message}`
    if (this.reported.has(id)) return
    this.reported.add(id)
    this.log.warn(`[keys] ${this.name}: the ${purpose} key is unavailable (${reason}): ${message}`)
    captureException(error, {
      tags: { component: 'keys', manager: this.name, purpose, reason },
      level: reason === 'secure-storage-unavailable' ? 'warning' : 'error',
    })
  }

  /** Try a key on what is sealed under its purpose: 'does-not-open' is a mismatch. */
  protected async verifyAgainstData(purpose: KeyPurpose, bytes: Buffer, where: string, userMessage: string): Promise<void> {
    const result = await this.probes[purpose](toKeyObject(bytes))
    if (result === 'does-not-open') {
      throw new KeyUnavailableError(
        purpose,
        'mismatch',
        `The ${purpose} key in ${where} does not open the data sealed under it`,
        userMessage,
      )
    }
  }

  /** Whether anything is sealed under the purpose (a fresh key opens nothing that exists). */
  protected async somethingSealed(purpose: KeyPurpose, candidate: Buffer): Promise<boolean> {
    return (await this.probes[purpose](toKeyObject(candidate))) !== 'nothing-sealed'
  }
}

function describeCustody(custody: KeyCustody): string {
  switch (custody) {
    case 'os-secure-storage': return 'the OS secure store'
    case 'plaintext-file': return 'a plaintext key file'
    case 'deployment-secret': return 'a deployment secret'
    case 'memory': return 'memory'
  }
}

export const consoleKeyLog: KeyLog = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
}
