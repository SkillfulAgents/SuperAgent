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
 * It is moved in unchanged: wrapped, given back by the OS store as the same
 * bytes, tried on the data sealed under it, and only then written; the
 * plaintext file is deleted once the written wrap reads back as the key. A
 * written wrap is never taken back (another process may use it). An
 * interrupted move finishes on the next start. A `.vault-key` beside a wrap
 * this computer cannot open (the data folder copied from another computer,
 * with its exported key) is the key if it opens the saved logins.
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
  /**
   * Where the OS store's own key is a file Chromium writes late (Windows, see
   * localStateHasOsKey): whether that key is on disk yet. Unset where the OS
   * holds the key itself.
   */
  osKeyOnDisk?: () => Promise<boolean>
  /** How long a new key waits for osKeyOnDisk before the call is reported and retried. */
  osKeyWaitMs?: number
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

/** Chromium writes Local State about ten seconds after a change. */
const OS_KEY_WAIT_MS = 15_000
const OS_KEY_POLL_MS = 250

const MISMATCH = 'The vault key on this computer does not open the saved logins. Restore the key they were saved with (an exported vault key file), or delete those logins in Settings → Logins.'
const MISSING = 'Saved logins on this computer were sealed with a vault key it does not have. Restore that key (an exported vault key file), or delete those logins in Settings → Logins.'
const CORRUPT = 'The Browser Vault key on this computer is damaged, so saved logins cannot be opened. Restore it from an exported vault key file.'
const IO = 'The Browser Vault key could not be read or saved on this computer. Check that the Gamut data folder can be written to, then try again.'
const OS_KEY_NOT_SAVED = 'The Browser Vault is not ready to save logins yet. Try again in a moment.'

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

/** The store answers but does not open the wrap: locked, or the wrap came from another computer with the data. */
function unopenable(backend: string): string {
  return `Gamut could not open the Browser Vault key with ${storeName(backend)}. If it is locked, unlock it and try again. If Gamut's data was copied from another computer, put that computer's exported vault key in Gamut's data folder as .vault-key and restart Gamut.`
}

export class DesktopKeyManager extends BaseKeyManager {
  readonly name = 'desktop'
  private readonly dataDir: string
  private readonly safeStorage: SafeStorageLike
  private readonly platform: NodeJS.Platform
  private readonly osKeyOnDisk?: () => Promise<boolean>
  private readonly osKeyWaitMs: number

  constructor(options: DesktopKeyManagerOptions) {
    super(options.probes, options.log ?? consoleKeyLog)
    this.dataDir = path.resolve(options.dataDir)
    this.safeStorage = options.safeStorage
    this.platform = options.platform
    this.osKeyOnDisk = options.osKeyOnDisk
    this.osKeyWaitMs = options.osKeyWaitMs ?? OS_KEY_WAIT_MS
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
    if (!available) return { available: false, backend, why: `${storeName(backend)} is not available` }
    // On Linux the async API says it is available even when the keyring
    // cannot be reached, and then encrypts with Chromium's fixed password
    // ("v10"); a key from the keyring is "v11". Seen with Electron 45 on a
    // session whose Secret Service did not answer. (On macOS and Windows "v10"
    // is the Keychain's or DPAPI's key.)
    if (this.platform === 'linux') {
      let tag: string
      try {
        tag = (await this.safeStorage.encryptStringAsync('gamut-store-check')).subarray(0, 3).toString('latin1')
      } catch {
        return { available: false, backend, why: `${storeName(backend)} could not encrypt` }
      }
      if (tag === 'v10') return { available: false, backend, why: `${storeName(backend)} could not be reached (Electron would protect the key with a fixed password)` }
    }
    return { available: true, backend }
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
      const unwrapped: Unwrapped = store.available ? await this.unwrap(purpose, wrapped.record) : { failed: 'decrypt' }
      if (!store.available || 'failed' in unwrapped) {
        const unusable = !store.available
          ? new KeyUnavailableError(purpose, 'secure-storage-unavailable', `The ${purpose} key is wrapped by ${wrapped.record.backend}, and ${store.why}`, locked(wrapped.record.backend))
          : 'failed' in unwrapped && unwrapped.failed === 'check'
            ? new KeyUnavailableError(purpose, 'corrupt', `${wrappedPath} did not unwrap to its key`, CORRUPT)
            : new KeyUnavailableError(
              purpose,
              'secure-storage-unavailable',
              `${storeName(store.backend)} could not unwrap the ${purpose} key (wrapped by ${wrapped.record.backend})`,
              unopenable(store.backend),
            )
        // The wrap does not open here — copied with the data from another
        // computer, or cut short while it was written — and a plaintext key
        // is beside it (an exported key, or the move's own source). That
        // key, if it opens the saved logins, is the key: it is wrapped here
        // in place of the one that does not open.
        if (legacy.state !== 'key' || !(await this.opensSealedData(purpose, legacy.bytes))) throw unusable
        if (!store.available) return this.plaintextFallback(purpose, legacy.bytes, store)
        return this.migrate(purpose, legacy.bytes, store, 'replace')
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
      if (!store.available) return this.plaintextFallback(purpose, legacy.bytes, store, true)
      return this.migrate(purpose, legacy.bytes, store, 'replace')
    }

    // No wrapped key yet.
    if (legacy.state === 'key') {
      const store = await this.secureStore()
      if (!store.available) return this.plaintextFallback(purpose, legacy.bytes, store, true)
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
    // A login sealed under a wrap the next start cannot open would be lost.
    if (!(await this.waitForOsKeyOnDisk())) {
      throw new KeyUnavailableError(purpose, 'secure-storage-unavailable', `${storeName(store.backend)}'s own key is not on disk yet, so no new ${purpose} key was made`, OS_KEY_NOT_SAVED)
    }
    // Checked before it is written: once on disk another process may use it,
    // so a wrapped key is never taken back.
    const wrap = await this.checkedWrap(purpose, candidate, store.backend)
    if (!wrap) {
      throw new KeyUnavailableError(purpose, 'secure-storage-unavailable', `${storeName(store.backend)} did not give back the new ${purpose} key it wrapped`, locked(store.backend))
    }
    if ((await this.writeExclusive(purpose, wrappedPath, JSON.stringify(wrap.record))) === 'exists') return RETRY
    const readBack = await this.readBack(purpose)
    if (!readBack || !sameKey(readBack, candidate)) {
      // Nothing seals under a key whose file does not give it back; the file stays for the next call to judge.
      throw new KeyUnavailableError(purpose, 'io', `${wrappedPath} did not read back as the key just written`, IO)
    }
    return { bytes: candidate, custody: 'os-secure-storage' }
  }

  /**
   * Move a plaintext key into the OS store, unchanged. Before anything is
   * written, the OS store has given the wrapped key back as the same bytes and
   * those bytes open what is sealed. Once written, the wrapped key stays —
   * another process may already use it — and the plaintext file goes only
   * after the wrapped one on disk reads back as the same key, and the OS
   * store's own key is on disk to open it after a crash. Anything short of that
   * leaves the plaintext key in use, as before, for the next start.
   */
  private async migrate(
    purpose: KeyPurpose,
    legacyBytes: Buffer,
    store: Extract<SecureStore, { available: true }>,
    mode: 'create' | 'replace',
  ): Promise<ResolvedKey | typeof RETRY> {
    const wrappedPath = this.wrappedPath(purpose)
    const legacyPath = this.legacyPath(purpose)
    const wrap = await this.checkedWrap(purpose, legacyBytes, store.backend)
    // The key under test is the plaintext file's (as the store gave it back): named as such when it does not open.
    await this.verifyAgainstData(purpose, wrap?.bytes ?? legacyBytes, legacyPath, MISMATCH)
    if (!wrap) {
      this.log.warn(`[keys] ${storeName(store.backend)} did not give back the ${purpose} key it wrapped; the plaintext key stays in use`)
      return { bytes: legacyBytes, custody: 'plaintext-file' }
    }
    try {
      if (mode === 'create') {
        if ((await writeFileExclusive(wrappedPath, JSON.stringify(wrap.record))) === 'exists') return RETRY
      } else {
        await replaceFileAtomic(wrappedPath, JSON.stringify(wrap.record))
      }
    } catch (error) {
      this.log.warn(`[keys] Moving the ${purpose} key into ${storeName(store.backend)} failed (${errorCode(error)}); the plaintext key stays in use`)
      return { bytes: legacyBytes, custody: 'plaintext-file' }
    }
    const readBack = await this.readBack(purpose)
    if (!readBack || !sameKey(readBack, legacyBytes)) {
      this.log.warn(`[keys] ${wrappedPath} did not read back as the ${purpose} key; ${legacyPath} is kept and the next start checks again`)
      return { bytes: legacyBytes, custody: 'plaintext-file' }
    }
    if (!(await this.osKeyProvenForMove(mode))) {
      this.log.warn(`[keys] ${storeName(store.backend)}'s own key may not be on disk yet; ${legacyPath} is kept and the next start finishes the move`)
      return { bytes: readBack, custody: 'plaintext-file' }
    }
    await this.retireLegacy(purpose, store)
    return { bytes: readBack, custody: 'os-secure-storage' }
  }

  /**
   * Whether the OS store's key that made this wrap would survive a crash now.
   * Replacing a wrap that did not open proves nothing from the file: the key
   * there may be the one that failed (another computer's), with a new one still
   * to be written. The next start proves it, by opening the wrap from disk.
   * Never waits: a move runs before the API binds.
   */
  private async osKeyProvenForMove(mode: 'create' | 'replace'): Promise<boolean> {
    if (!this.osKeyOnDisk) return true
    return mode === 'create' && this.osKeyOnDisk()
  }

  private async waitForOsKeyOnDisk(): Promise<boolean> {
    if (!this.osKeyOnDisk) return true
    const deadline = Date.now() + this.osKeyWaitMs
    while (!(await this.osKeyOnDisk())) {
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, OS_KEY_POLL_MS))
    }
    return true
  }

  /** The plaintext key, as before, while the OS store cannot hold it; checked against the sealed data unless the caller just did. */
  private async plaintextFallback(
    purpose: KeyPurpose,
    bytes: Buffer,
    store: Extract<SecureStore, { available: false }>,
    verify = false,
  ): Promise<ResolvedKey> {
    if (verify) await this.verifyAgainstData(purpose, bytes, this.legacyPath(purpose), MISMATCH)
    this.log.warn(`[keys] The ${purpose} key stays in plaintext in ${this.legacyPath(purpose)}: ${store.why}. It moves into the OS store on a later start once there is one.`)
    return { bytes, custody: 'plaintext-file' }
  }

  /** A wrap of the key that the OS store has already given back unchanged; null when it did not. */
  private async checkedWrap(purpose: KeyPurpose, bytes: Buffer, backend: string): Promise<{ record: WrappedKeyFile; bytes: Buffer } | null> {
    let record: WrappedKeyFile
    try {
      record = await this.wrap(purpose, bytes, backend)
    } catch {
      return null
    }
    const check = await this.unwrap(purpose, record)
    return 'failed' in check || !sameKey(check.bytes, bytes) ? null : { record, bytes: check.bytes }
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
      const wrap = await this.checkedWrap(purpose, bytes, store.backend)
      if (wrap) await replaceFileAtomic(this.wrappedPath(purpose), JSON.stringify(wrap.record))
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
