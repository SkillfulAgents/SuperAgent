import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openJson } from '@shared/lib/browser-vault/vault-crypto'
import { accountSecretsSchema } from '@shared/lib/browser-vault/vault-schemas'
import { installKeyManager, uninstallKeyManager } from '@shared/lib/keys/key-manager'
import { FakeSealedData, memoryLog } from '@shared/lib/keys/testing/fake-probe'
import { DesktopKeyManager, type SafeStorageLike } from './desktop-key-manager'

/**
 * Electron safeStorage as the OS gives it: a key only this "computer" holds
 * (a new FakeSafeStorage is another computer), a backend, and a lock.
 */
class FakeSafeStorage implements SafeStorageLike {
  private readonly osKey = crypto.randomBytes(32)
  backend = 'gnome_libsecret'
  available = true
  reEncrypt = false
  /** Chromium's scheme tag: on Linux 'v11' is a keyring key, 'v10' its fixed-password fallback. */
  tag = 'v11'
  /** Key wraps (not the store's own availability check). */
  wraps = 0

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  async encryptStringAsync(plainText: string): Promise<Buffer> {
    if (!this.available) throw new Error('locked')
    if (plainText !== 'gamut-store-check') this.wraps++
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.osKey, iv)
    const body = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()])
    return Buffer.concat([Buffer.from(this.tag), iv, cipher.getAuthTag(), body])
  }

  async decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    if (!this.available) throw new Error('locked')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.osKey, encrypted.subarray(3, 15))
    decipher.setAuthTag(encrypted.subarray(15, 31))
    const result = Buffer.concat([decipher.update(encrypted.subarray(31)), decipher.final()]).toString('utf-8')
    return { result, shouldReEncrypt: this.reEncrypt }
  }
}

/** One process's view of a shared OS store, with a hook before each of its decrypts (to interleave another process). */
class HookedSafeStorage implements SafeStorageLike {
  decrypts = 0
  constructor(private readonly inner: FakeSafeStorage, private readonly beforeDecrypt: (n: number) => Promise<void>) {}
  isAsyncEncryptionAvailable() { return this.inner.isAsyncEncryptionAvailable() }
  getSelectedStorageBackend() { return this.inner.getSelectedStorageBackend() }
  encryptStringAsync(plainText: string) { return this.inner.encryptStringAsync(plainText) }
  async decryptStringAsync(encrypted: Buffer) {
    await this.beforeDecrypt(++this.decrypts)
    return this.inner.decryptStringAsync(encrypted)
  }
}

let dataDir: string
let safeStorage: FakeSafeStorage
let data: FakeSealedData
let log: ReturnType<typeof memoryLog>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-keys-'))
  safeStorage = new FakeSafeStorage()
  data = new FakeSealedData()
  log = memoryLog()
})

afterEach(() => {
  uninstallKeyManager()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const legacyFile = () => path.join(dataDir, '.vault-key')
const wrappedFile = () => path.join(dataDir, '.vault-key.wrapped')
const manager = (storage: SafeStorageLike = safeStorage, dir = dataDir, platform: NodeJS.Platform = 'linux') =>
  new DesktopKeyManager({ dataDir: dir, safeStorage: storage, platform, probes: data.probes, log })
const bytesOf = async (m: DesktopKeyManager) => (await m.key('browser-vault')).export()
const files = () => fs.readdirSync(dataDir).sort()
const binding = { purpose: 'account-secrets' as const, id: 'acc-1', site: 'github.com' }

function writeLegacy(key: Buffer): void {
  fs.writeFileSync(legacyFile(), key.toString('base64'), { mode: 0o600 })
}

/** Sealed the way the vault always has, under a raw key. */
function legacySeal(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(`${binding.purpose}\0${binding.id}\0${binding.site}`, 'utf-8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

describe('DesktopKeyManager: moving the legacy key file into the OS store', () => {
  it('imports the key unchanged at start, verified on the sealed data, and then deletes the plaintext file', async () => {
    const key = crypto.randomBytes(32)
    writeLegacy(key)
    data.sealedUnder = key
    const sealed = legacySeal(JSON.stringify({ values: { password: 'old' } }), key)

    await installKeyManager(manager())
    expect(files()).toEqual(['.vault-key.wrapped'])
    // The wrapped file alone holds no key.
    expect(fs.readFileSync(wrappedFile(), 'utf-8')).not.toContain(key.toString('base64'))
    if (process.platform !== 'win32') expect(fs.statSync(wrappedFile()).mode & 0o777).toBe(0o600)
    await expect(openJson(sealed, binding, accountSecretsSchema)).resolves.toEqual({ values: { password: 'old' } })

    // The next start reads it back from the OS store.
    uninstallKeyManager()
    await installKeyManager(manager())
    await expect(openJson(sealed, binding, accountSecretsSchema)).resolves.toEqual({ values: { password: 'old' } })
    expect(log.lines.join('\n')).not.toContain(key.toString('base64'))
  })

  it('keeps the plaintext file, and moves nothing, when its key does not open what is sealed', async () => {
    writeLegacy(crypto.randomBytes(32))
    data.sealedUnder = crypto.randomBytes(32)
    const m = manager()
    await m.initialize()
    await expect(m.key('browser-vault')).rejects.toMatchObject({ reason: 'mismatch' })
    expect(files()).toEqual(['.vault-key'])
  })

  it('finishes a move cut short after the wrapped file was written', async () => {
    const key = crypto.randomBytes(32)
    writeLegacy(key)
    data.sealedUnder = key
    await manager().initialize()
    // As if the process died before deleting it.
    writeLegacy(key)
    await manager().initialize()
    expect(files()).toEqual(['.vault-key.wrapped'])
  })

  it('moves again when the wrapped file was cut short while it was written', async () => {
    const key = crypto.randomBytes(32)
    writeLegacy(key)
    fs.writeFileSync(wrappedFile(), '{"version":1,"purp')
    const m = manager()
    expect((await bytesOf(m)).equals(key)).toBe(true)
    expect(files()).toEqual(['.vault-key.wrapped'])
    expect((await bytesOf(manager())).equals(key)).toBe(true)
  })

  it('keeps using the plaintext file, as before, on a desktop with no keyring, and moves it in once there is one', async () => {
    const key = crypto.randomBytes(32)
    writeLegacy(key)
    safeStorage.backend = 'basic_text'
    expect((await bytesOf(manager())).equals(key)).toBe(true)
    expect(files()).toEqual(['.vault-key'])
    expect(safeStorage.wraps).toBe(0)
    expect(log.lines.some((line) => line.includes('stays in plaintext') && line.includes('no OS keyring'))).toBe(true)

    safeStorage.backend = 'kwallet6'
    await manager().initialize()
    expect(files()).toEqual(['.vault-key.wrapped'])
    expect((await bytesOf(manager())).equals(key)).toBe(true)
  })
})

describe('DesktopKeyManager: a fresh install', () => {
  it('makes no key until the vault first seals, then keeps it wrapped by the OS store', async () => {
    const m = manager(safeStorage, dataDir, 'darwin')
    await m.initialize()
    expect(files()).toEqual([])
    const key = await bytesOf(m)
    expect(files()).toEqual(['.vault-key.wrapped'])
    expect(JSON.parse(fs.readFileSync(wrappedFile(), 'utf-8'))).toMatchObject({ backend: 'keychain', protection: 'electron-safe-storage' })
    expect((await bytesOf(manager(safeStorage, dataDir, 'darwin'))).equals(key)).toBe(true)
  })

  it('makes a plaintext key file, as before, when there is no keyring', async () => {
    safeStorage.backend = 'basic_text'
    const key = await bytesOf(manager())
    expect(files()).toEqual(['.vault-key'])
    expect(fs.readFileSync(legacyFile(), 'utf-8')).toBe(key.toString('base64'))
    if (process.platform !== 'win32') expect(fs.statSync(legacyFile()).mode & 0o777).toBe(0o600)
  })

  it('never makes a key over sealed data it has no key for', async () => {
    data.sealedUnder = crypto.randomBytes(32)
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'missing' })
    safeStorage.backend = 'basic_text'
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'missing' })
    expect(files()).toEqual([])
  })

  it('agrees on one key when first uses race, in one process or two', async () => {
    const one = manager()
    const keys = await Promise.all(Array.from({ length: 8 }, () => bytesOf(one)))
    expect(new Set(keys.map((key) => key.toString('base64'))).size).toBe(1)
    expect(safeStorage.wraps).toBe(1)

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-keys-race-'))
    try {
      const raced = await Promise.all(Array.from({ length: 5 }, () => bytesOf(manager(safeStorage, otherDir))))
      expect(new Set(raced.map((key) => key.toString('base64'))).size).toBe(1)
      expect(fs.readdirSync(otherDir)).toEqual(['.vault-key.wrapped'])
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

describe('DesktopKeyManager: a key it cannot hand out', () => {
  it('reports a locked keychain, keeps everything as it is, and opens once it is unlocked', async () => {
    const key = await bytesOf(manager())
    data.sealedUnder = key
    const before = fs.readFileSync(wrappedFile(), 'utf-8')
    safeStorage.available = false
    const m = manager()
    await m.initialize()
    await expect(m.key('browser-vault')).rejects.toMatchObject({ reason: 'secure-storage-unavailable', userMessage: expect.stringContaining('Unlock') })
    expect(files()).toEqual(['.vault-key.wrapped'])
    expect(fs.readFileSync(wrappedFile(), 'utf-8')).toBe(before)

    safeStorage.available = true
    expect((await bytesOf(m)).equals(key)).toBe(true)
  })

  it('reports a wrapped key from another computer (or a reset keychain) instead of replacing it', async () => {
    await bytesOf(manager())
    data.sealedUnder = crypto.randomBytes(32)
    const before = fs.readFileSync(wrappedFile(), 'utf-8')
    // The user is told both ways out: unlock, or bring the other computer's exported key.
    await expect(manager(new FakeSafeStorage()).key('browser-vault')).rejects.toMatchObject({
      reason: 'secure-storage-unavailable',
      userMessage: expect.stringContaining('exported vault key in Gamut\'s data folder as .vault-key'),
    })
    expect(fs.readFileSync(wrappedFile(), 'utf-8')).toBe(before)
  })

  it('does not take the fixed-password fallback for a keyring (Linux: available, but nothing answered)', async () => {
    const key = crypto.randomBytes(32)
    writeLegacy(key)
    safeStorage.tag = 'v10'
    expect((await bytesOf(manager())).equals(key)).toBe(true)
    // Nothing wrapped under the fixed password: the plaintext file stays, as on a desktop with no keyring.
    expect(files()).toEqual(['.vault-key'])
    expect(safeStorage.wraps).toBe(0)
    expect(log.lines.some((line) => line.includes('could not be reached'))).toBe(true)
    // On macOS the same tag is the Keychain's key.
    expect((await bytesOf(manager(safeStorage, dataDir, 'darwin'))).equals(key)).toBe(true)
    expect(files()).toEqual(['.vault-key.wrapped'])
  })

  it('reports a keyring that is gone (a session without one) instead of falling back to a new plaintext key', async () => {
    await bytesOf(manager())
    safeStorage.backend = 'basic_text'
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'secure-storage-unavailable' })
    expect(files()).toEqual(['.vault-key.wrapped'])
  })

  it('never writes over a damaged wrapped key or key file', async () => {
    fs.writeFileSync(wrappedFile(), 'damaged')
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fs.readFileSync(wrappedFile(), 'utf-8')).toBe('damaged')
    fs.rmSync(wrappedFile())
    fs.writeFileSync(legacyFile(), 'not a key')
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fs.readFileSync(legacyFile(), 'utf-8')).toBe('not a key')
  })

  it('reports two different keys rather than choosing one', async () => {
    await bytesOf(manager())
    writeLegacy(crypto.randomBytes(32))
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'conflict' })
    expect(files()).toEqual(['.vault-key', '.vault-key.wrapped'])
  })
})

describe('DesktopKeyManager: upkeep and transfer', () => {
  it('re-wraps the key when the OS store asks, keeping the same key', async () => {
    const key = await bytesOf(manager())
    const before = fs.readFileSync(wrappedFile(), 'utf-8')
    safeStorage.reEncrypt = true
    expect((await bytesOf(manager())).equals(key)).toBe(true)
    expect(fs.readFileSync(wrappedFile(), 'utf-8')).not.toBe(before)
    safeStorage.reEncrypt = false
    expect((await bytesOf(manager())).equals(key)).toBe(true)
  })

  it('exports the key to a file that another computer takes in as its .vault-key', async () => {
    const exportPath = path.join(dataDir, 'exported.txt')
    expect(await manager().exportKeyFile('browser-vault', exportPath)).toBe('no-key')
    expect(fs.existsSync(exportPath)).toBe(false)

    const key = await bytesOf(manager())
    data.sealedUnder = key
    expect(await manager().exportKeyFile('browser-vault', exportPath)).toBe('written')
    if (process.platform !== 'win32') expect(fs.statSync(exportPath).mode & 0o777).toBe(0o600)

    // Another computer: its own OS store, the export as its .vault-key.
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-keys-other-'))
    try {
      fs.copyFileSync(exportPath, path.join(otherDir, '.vault-key'))
      const other = manager(new FakeSafeStorage(), otherDir)
      await other.initialize()
      expect(fs.readdirSync(otherDir)).toEqual(['.vault-key.wrapped'])
      expect((await bytesOf(other)).equals(key)).toBe(true)
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  /** This computer's whole data folder copied to another, with the exported key placed in it as .vault-key. */
  async function copyToAnotherComputer(): Promise<{ key: Buffer; otherDir: string }> {
    const key = await bytesOf(manager())
    data.sealedUnder = key
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-keys-copy-'))
    fs.cpSync(dataDir, otherDir, { recursive: true })
    expect(await manager().exportKeyFile('browser-vault', path.join(otherDir, '.vault-key'))).toBe('written')
    expect(fs.readdirSync(otherDir).sort()).toEqual(['.vault-key', '.vault-key.wrapped'])
    return { key, otherDir }
  }

  it('takes in the exported key when the whole data folder is copied, wrap from the old computer and all', async () => {
    const { key, otherDir } = await copyToAnotherComputer()
    const copiedWrap = fs.readFileSync(path.join(otherDir, '.vault-key.wrapped'), 'utf-8')
    try {
      const otherStore = new FakeSafeStorage()
      await manager(otherStore, otherDir).initialize()
      // The old computer's wrap is replaced by this computer's, and the plaintext copy goes.
      expect(fs.readdirSync(otherDir)).toEqual(['.vault-key.wrapped'])
      expect(fs.readFileSync(path.join(otherDir, '.vault-key.wrapped'), 'utf-8')).not.toBe(copiedWrap)
      expect((await bytesOf(manager(otherStore, otherDir))).equals(key)).toBe(true)
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('uses the exported key on a copied folder whose new computer has no keyring, as before', async () => {
    const { key, otherDir } = await copyToAnotherComputer()
    try {
      const otherStore = new FakeSafeStorage()
      otherStore.backend = 'basic_text'
      expect((await bytesOf(manager(otherStore, otherDir))).equals(key)).toBe(true)
      expect(fs.readdirSync(otherDir).sort()).toEqual(['.vault-key', '.vault-key.wrapped'])
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('does not take a key file that does not open the saved logins in place of a wrap it cannot open', async () => {
    const { otherDir } = await copyToAnotherComputer()
    try {
      fs.writeFileSync(path.join(otherDir, '.vault-key'), crypto.randomBytes(32).toString('base64'))
      const before = fs.readFileSync(path.join(otherDir, '.vault-key.wrapped'), 'utf-8')
      await expect(manager(new FakeSafeStorage(), otherDir).key('browser-vault')).rejects.toMatchObject({ reason: 'secure-storage-unavailable' })
      expect(fs.readdirSync(otherDir).sort()).toEqual(['.vault-key', '.vault-key.wrapped'])
      expect(fs.readFileSync(path.join(otherDir, '.vault-key.wrapped'), 'utf-8')).toBe(before)
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

describe('DesktopKeyManager: two processes on one data folder', () => {
  /** B's first decrypt once its wrap is on disk (its read-back): run `other` there, then fail that decrypt. */
  const atReadBack = (other: () => Promise<void>) => {
    let fired = false
    return new HookedSafeStorage(safeStorage, async () => {
      if (fired || !fs.existsSync(wrappedFile())) return
      fired = true
      await other()
      throw new Error('transient')
    })
  }

  it('never loses the key when one finishes a move while the other\'s read-back fails', async () => {
    const key = crypto.randomBytes(32)
    writeLegacy(key)
    data.sealedUnder = key
    // B writes the wrap; before its read-back, A finishes the move and deletes .vault-key; then B's read-back fails.
    const b = manager(atReadBack(async () => {
      await manager().initialize()
      expect(files()).toEqual(['.vault-key.wrapped'])
    }))
    // B could not confirm the wrap, so it goes on with the plaintext key it had in memory, deleting nothing.
    expect((await bytesOf(b)).equals(key)).toBe(true)
    expect(files()).toEqual(['.vault-key.wrapped'])
    expect((await bytesOf(manager())).equals(key)).toBe(true)
  })

  it('never takes back a fresh wrapped key another process may already seal with', async () => {
    let sealedBy: Buffer | null = null
    // A uses the key B just wrote, and seals with it; then B's read-back fails.
    const b = manager(atReadBack(async () => {
      sealedBy = await bytesOf(manager())
      data.sealedUnder = sealedBy
    }))
    await expect(b.key('browser-vault')).rejects.toMatchObject({ reason: 'io' })
    expect(files()).toEqual(['.vault-key.wrapped'])
    expect(sealedBy).not.toBeNull()
    expect((await bytesOf(manager())).equals(sealedBy!)).toBe(true)
  })
})
