import fs from 'fs/promises'
import path from 'path'
import { BaseKeyManager, consoleKeyLog, type KeyLog, type ResolvedKey } from '@shared/lib/keys/base-key-manager'
import { KeyUnavailableError, type KeyProbes, type KeyPurpose } from '@shared/lib/keys/key-manager'
import {
  decodeKey,
  encodeKey,
  generateKeyBytes,
  keyBytes,
  keyCheckValue,
  readKeyFile,
  removeFile,
  replaceFileAtomic,
  sameKey,
  writeFileExclusive,
} from '@shared/lib/keys/key-material'
import { wrappedKeyFileSchema, type WrappedKeyFile } from './wrapped-key-schema'

/**
 * Key custody on the desktop: each purpose's key is wrapped by Electron
 * safeStorage — whose own key is in the macOS Keychain, Windows DPAPI, or the
 * Linux keyring (libsecret, KWallet) — and the wrapped key is kept in the data
 * directory. Neither the OS's key nor the unwrapped one is ever in the
 * database or a file.
 *
 * Installs from before KeyManager hold the key in plaintext (`.vault-key`).
 * It is moved in unchanged: wrapped, written, read back and unwrapped by the
 * OS store, compared, tried on the data sealed under it, and only then is the
 * plaintext file deleted. An interrupted move finishes on the next start.
 *
 * Without a usable OS store (a Linux desktop with no keyring, where Electron
 * would fall back to a hard-coded password) the plaintext file stays in use, as
 * before, and is moved in on a later start once there is one. A key that was
 * wrapped is never replaced by a new one when the store is locked or the file
 * damaged: the vault reports why instead.
 */

/** The parts of Electron's safeStorage this uses (injected, so it is testable without Electron). */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  getSelectedStorageBackend(): string
}

export interface DesktopKeyManagerOptions {
  dataDir: string
  safeStorage: SafeStorageLike
  platform: NodeJS.Platform
  probes: KeyProbes
  log?: KeyLog
}

interface PurposeFiles {
  wrapped: string
  legacy: string
}

export const DESKTOP_KEY_FILES: Readonly<Record<KeyPurpose, PurposeFiles>> = {
  'browser-vault': { wrapped: '.vault-key.wrapped', legacy: '.vault-key' },
}

type SecureStore = { available: true; backend: string } | { available: false; backend: string; why: string }

type WrappedRead =
  | { state: 'absent' }
  | { state: 'record'; record: WrappedKeyFile }
  | { state: 'invalid' }
  | { state: 'unreadable'; code: string }

type Unwrapped = { bytes: Buffer; shouldReEncrypt: boolean } | { failed: 'decrypt' | 'check' }

const RETRY = Symbol('retry')

const MISMATCH = 'The vault key on this computer does not open the saved logins. Restore the key they were saved with (an exported vault key file), or delete those logins in Settings → Logins.'
const MISSING = 'Saved logins on this computer were sealed with a vault key it does not have. Restore that key (an exported vault key file), or delete those logins in Settings → Logins.'
const CORRUPT = 'The Browser Vault key on this computer is damaged, so saved logins cannot be opened. Restore it from an exported vault key file.'
const IO = 'The Browser Vault key could not be read or saved on this computer. Check that the Gamut data folder can be written to, then try again.'

function storeName(backend: string): string {
  switch (backend) {
    case 'keychain': return 'the macOS Keychain'
    case 'dpapi': return 'Windows data protection'
    case 'gnome_libsecret': return 'your keyring (Secret Service)'
    case 'kwallet':
    case 'kwallet5':
    case 'kwallet6': return 'KWallet'
    default: return 'the system keyring'
  }
}

function locked(backend: string): string {
  return `Gamut could not open the Browser Vault key from ${storeName(backend)}. Unlock it (or sign in to your desktop session's keyring), then try again.`
}

export class DesktopKeyManager extends BaseKeyManager {
  readonly name = 'desktop'
  private readonly dataDir: string
  private readonly safeStorage: SafeStorageLike
  private readonly platform: NodeJS.Platform

  constructor(options: DesktopKeyManagerOptions) {
    super(options.probes, options.log ?? consoleKeyLog)
    this.dataDir = path.resolve(options.dataDir)
    this.safeStorage = options.safeStorage
    this.platform = options.platform
  }

  private wrappedPath(purpose: KeyPurpose): string {
    return path.join(this.dataDir, DESKTOP_KEY_FILES[purpose].wrapped)
  }

  private legacyPath(purpose: KeyPurpose): string {
    return path.join(this.dataDir, DESKTOP_KEY_FILES[purpose].legacy)
  }

  /**
   * Whether the OS can protect a key now. Asked each time rather than
   * remembered: a keyring unlocked later is picked up. On Linux, Electron's
   * `basic_text` backend is a hard-coded password, not protection.
   */
  private async secureStore(): Promise<SecureStore> {
    const backend = this.platform === 'darwin' ? 'keychain'
      : this.platform === 'win32' ? 'dpapi'
      : this.safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text') return { available: false, backend, why: 'no OS keyring was found (Electron would protect the key with a fixed password)' }
    if (backend === 'unknown') return { available: false, backend, why: 'the OS keyring is not ready yet' }
    let available = false
    try {
      available = await this.safeStorage.isAsyncEncryptionAvailable()
    } catch {
      available = false
    }
    return available ? { available: true, backend } : { available: false, backend, why: `${storeName(backend)} is not available` }
  }

  protected async resolve(purpose: KeyPurpose, { create }: { create: boolean }): Promise<ResolvedKey | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await this.resolveOnce(purpose, create)
      if (outcome !== RETRY) return outcome
    }
    throw new KeyUnavailableError(purpose, 'io', `The ${purpose} key files kept changing while they were read`, IO)
  }

  private async resolveOnce(purpose: KeyPurpose, create: boolean): Promise<ResolvedKey | null | typeof RETRY> {
    const wrappedPath = this.wrappedPath(purpose)
    const legacyPath = this.legacyPath(purpose)
    const wrapped = await this.readWrapped(wrappedPath)
    const legacy = await readKeyFile(legacyPath)

    if (wrapped.state === 'unreadable') {
      throw new KeyUnavailableError(purpose, 'io', `${wrappedPath} could not be read (${wrapped.code})`, IO)
    }

    if (wrapped.state === 'record') {
      const store = await this.secureStore()
      if (!store.available) {
        throw new KeyUnavailableError(purpose, 'secure-storage-unavailable', `The ${purpose} key is wrapped by ${wrapped.record.backend}, and ${store.why}`, locked(wrapped.record.backend))
      }
      const unwrapped = await this.unwrap(purpose, wrapped.record)
      if ('failed' in unwrapped) {
        // A damaged wrap with the plaintext key still beside it: a move that was cut short. Move it again.
        if (unwrapped.failed === 'check' && legacy.state === 'key') return this.migrate(purpose, legacy.bytes, store, 'replace')
        if (unwrapped.failed === 'check') {
          throw new KeyUnavailableError(purpose, 'corrupt', `${wrappedPath} did not unwrap to its key`, CORRUPT)
        }
        throw new KeyUnavailableError(
          purpose,
          'secure-storage-unavailable',
          `${storeName(store.backend)} could not unwrap the ${purpose} key (wrapped by ${wrapped.record.backend})`,
          locked(wrapped.record.backend),
        )
      }
      if (legacy.state === 'key') {
        if (!sameKey(legacy.bytes, unwrapped.bytes)) {
          throw new KeyUnavailableError(
            purpose,
            'conflict',
            `${wrappedPath} and ${legacyPath} hold different ${purpose} keys`,
            `Two different Browser Vault keys are on this computer: one protected by ${storeName(wrapped.record.backend)} and one in ${legacyPath}. Delete the one you do not want to keep, then restart Gamut.`,
          )
        }
        // A move that stopped before the plaintext file went: check, then finish it.
        await this.verifyAgainstData(purpose, unwrapped.bytes, wrappedPath, MISMATCH)
        await this.retireLegacy(purpose, store)
      } else {
        if (legacy.state === 'invalid') this.log.warn(`[keys] ${legacyPath} holds no key; it is ignored (the key is in ${storeName(wrapped.record.backend)})`)
        await this.verifyAgainstData(purpose, unwrapped.bytes, wrappedPath, MISMATCH)
      }
      if (unwrapped.shouldReEncrypt) await this.rewrap(purpose, unwrapped.bytes, store)
      return { bytes: unwrapped.bytes, custody: 'os-secure-storage' }
    }

    if (wrapped.state === 'invalid') {
      if (legacy.state !== 'key') {
        throw new KeyUnavailableError(purpose, 'corrupt', `${wrappedPath} does not hold a wrapped key; it is never written over`, CORRUPT)
      }
      // Cut short while it was written: the plaintext key is still the key.
      const store = await this.secureStore()
      if (!store.available) return this.plaintextFallback(purpose, legacy.bytes, store)
      return this.migrate(purpose, legacy.bytes, store, 'replace')
    }

    // No wrapped key yet.
    if (legacy.state === 'key') {
      await this.verifyAgainstData(purpose, legacy.bytes, legacyPath, MISMATCH)
      const store = await this.secureStore()
      if (!store.available) return this.plaintextFallback(purpose, legacy.bytes, store)
      return this.migrate(purpose, legacy.bytes, store, 'create')
    }
    if (legacy.state === 'invalid') {
      throw new KeyUnavailableError(purpose, 'corrupt', `${legacyPath} does not hold a key; it is never written over`, CORRUPT)
    }
    if (legacy.state === 'unreadable') {
      throw new KeyUnavailableError(purpose, 'io', `${legacyPath} could not be read (${legacy.code})`, IO)
    }
    if (!create) return null

    const candidate = generateKeyBytes()
    if (await this.somethingSealed(purpose, candidate)) {
      throw new KeyUnavailableError(purpose, 'missing', `Data is sealed under ${purpose} but this computer holds no key for it`, MISSING)
    }
    const store = await this.secureStore()
    if (!store.available) {
      this.log.warn(`[keys] The new ${purpose} key is kept in plaintext in ${legacyPath}: ${store.why}. It moves into the OS store on a later start once there is one.`)
      return (await this.writeExclusive(purpose, legacyPath, encodeKey(candidate))) === 'created'
        ? { bytes: candidate, custody: 'plaintext-file' }
        : RETRY
    }
    const record = await this.wrapOrThrow(purpose, candidate, store.backend)
    if ((await this.writeExclusive(purpose, wrappedPath, JSON.stringify(record))) === 'exists') return RETRY
    const readBack = await this.readBack(purpose)
    if (!readBack || !sameKey(readBack, candidate)) {
      // Nothing is sealed under it yet: take it back rather than leave a key that does not unwrap.
      await removeFile(wrappedPath).catch(() => {})
      throw new KeyUnavailableError(purpose, 'secure-storage-unavailable', `${storeName(store.backend)} did not give back the ${purpose} key it wrapped`, locked(store.backend))
    }
    return { bytes: candidate, custody: 'os-secure-storage' }
  }

  /**
   * Move a plaintext key into the OS store, unchanged. The plaintext file goes
   * only after the wrapped one, read back from disk, unwraps to the same bytes
   * and opens what is sealed. Anything short of that leaves the plaintext key
   * in use, as before, for the next start to try again.
   */
  private async migrate(
    purpose: KeyPurpose,
    legacyBytes: Buffer,
    store: Extract<SecureStore, { available: true }>,
    mode: 'create' | 'replace',
  ): Promise<ResolvedKey | typeof RETRY> {
    const wrappedPath = this.wrappedPath(purpose)
    try {
      const record = await this.wrap(purpose, legacyBytes, store.backend)
      if (mode === 'create') {
        if ((await writeFileExclusive(wrappedPath, JSON.stringify(record))) === 'exists') return RETRY
      } else {
        await replaceFileAtomic(wrappedPath, JSON.stringify(record))
      }
    } catch (error) {
      this.log.warn(`[keys] Moving the ${purpose} key into ${storeName(store.backend)} failed (${errorCode(error)}); the plaintext key stays in use`)
      return { bytes: legacyBytes, custody: 'plaintext-file' }
    }
    const readBack = await this.readBack(purpose)
    if (!readBack || !sameKey(readBack, legacyBytes)) {
      await removeFile(wrappedPath).catch(() => {})
      this.log.warn(`[keys] ${storeName(store.backend)} did not give back the ${purpose} key it wrapped; the plaintext key stays in use`)
      return { bytes: legacyBytes, custody: 'plaintext-file' }
    }
    try {
      await this.verifyAgainstData(purpose, readBack, wrappedPath, MISMATCH)
    } catch (error) {
      await removeFile(wrappedPath).catch(() => {})
      throw error
    }
    await this.retireLegacy(purpose, store)
    return { bytes: readBack, custody: 'os-secure-storage' }
  }

  private plaintextFallback(purpose: KeyPurpose, bytes: Buffer, store: Extract<SecureStore, { available: false }>): ResolvedKey {
    this.log.warn(`[keys] The ${purpose} key stays in plaintext in ${this.legacyPath(purpose)}: ${store.why}. It moves into the OS store on a later start once there is one.`)
    return { bytes, custody: 'plaintext-file' }
  }

  private async retireLegacy(purpose: KeyPurpose, store: Extract<SecureStore, { available: true }>): Promise<void> {
    const legacyPath = this.legacyPath(purpose)
    try {
      await removeFile(legacyPath)
      this.log.info(`[keys] Moved the ${purpose} key from ${legacyPath} into ${storeName(store.backend)}`)
    } catch (error) {
      // The wrapped key is in use; the next start deletes the copy (same key).
      this.log.warn(`[keys] The ${purpose} key is now in ${storeName(store.backend)}, but ${legacyPath} could not be deleted (${errorCode(error)})`)
    }
  }

  /** A fresh wrap, checked before it replaces the old one (safeStorage asked for it: its own key rotated). */
  private async rewrap(purpose: KeyPurpose, bytes: Buffer, store: Extract<SecureStore, { available: true }>): Promise<void> {
    try {
      const record = await this.wrap(purpose, bytes, store.backend)
      const check = await this.unwrap(purpose, record)
      if ('failed' in check || !sameKey(check.bytes, bytes)) return
      await replaceFileAtomic(this.wrappedPath(purpose), JSON.stringify(record))
    } catch (error) {
      this.log.warn(`[keys] Re-wrapping the ${purpose} key failed (${errorCode(error)}); the current wrap stays`)
    }
  }

  private async wrap(purpose: KeyPurpose, bytes: Buffer, backend: string): Promise<WrappedKeyFile> {
    const wrapped = await this.safeStorage.encryptStringAsync(encodeKey(bytes))
    return wrappedKeyFileSchema.parse({
      version: 1,
      purpose,
      protection: 'electron-safe-storage',
      backend,
      wrapped: wrapped.toString('base64'),
      check: keyCheckValue(bytes, purpose),
      createdAt: new Date().toISOString(),
    })
  }

  private async wrapOrThrow(purpose: KeyPurpose, bytes: Buffer, backend: string): Promise<WrappedKeyFile> {
    try {
      return await this.wrap(purpose, bytes, backend)
    } catch {
      throw new KeyUnavailableError(purpose, 'secure-storage-unavailable', `${storeName(backend)} could not wrap the ${purpose} key`, locked(backend))
    }
  }

  private async unwrap(purpose: KeyPurpose, record: WrappedKeyFile): Promise<Unwrapped> {
    if (record.purpose !== purpose) return { failed: 'check' }
    let decrypted: { result: string; shouldReEncrypt: boolean }
    try {
      decrypted = await this.safeStorage.decryptStringAsync(Buffer.from(record.wrapped, 'base64'))
    } catch {
      return { failed: 'decrypt' }
    }
    const bytes = decodeKey(decrypted.result)
    if (!bytes || keyCheckValue(bytes, purpose) !== record.check) return { failed: 'check' }
    return { bytes, shouldReEncrypt: decrypted.shouldReEncrypt }
  }

  /** The wrapped key as it is on disk now, unwrapped: what the next start will get. */
  private async readBack(purpose: KeyPurpose): Promise<Buffer | null> {
    const read = await this.readWrapped(this.wrappedPath(purpose))
    if (read.state !== 'record') return null
    const unwrapped = await this.unwrap(purpose, read.record)
    return 'failed' in unwrapped ? null : unwrapped.bytes
  }

  private async readWrapped(filePath: string): Promise<WrappedRead> {
    let text: string
    try {
      text = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      const code = errorCode(error)
      return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', code }
    }
    try {
      const parsed = wrappedKeyFileSchema.safeParse(JSON.parse(text))
      return parsed.success ? { state: 'record', record: parsed.data } : { state: 'invalid' }
    } catch {
      return { state: 'invalid' }
    }
  }

  private async writeExclusive(purpose: KeyPurpose, filePath: string, data: string): Promise<'created' | 'exists'> {
    try {
      return await writeFileExclusive(filePath, data)
    } catch (error) {
      throw new KeyUnavailableError(purpose, 'io', `${filePath} could not be written (${errorCode(error)})`, IO)
    }
  }

  /**
   * Write the purpose's key to a file the user chose, in the plaintext key
   * file format: what moves a vault to another computer (placed there as
   * `.vault-key`, it is moved into that computer's OS store on start). Main
   * process only — the key never crosses IPC. 'no-key' when nothing has made
   * one yet.
   */
  async exportKeyFile(purpose: KeyPurpose, destination: string): Promise<'written' | 'no-key'> {
    const key = await this.existingKey(purpose)
    if (!key) return 'no-key'
    await fs.writeFile(destination, `${encodeKey(keyBytes(key))}\n`, { mode: 0o600 })
    await fs.chmod(destination, 0o600).catch(() => {})
    return 'written'
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : 'error')
}
