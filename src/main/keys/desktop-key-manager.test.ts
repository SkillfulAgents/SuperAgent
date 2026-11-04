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
  encryptCalls = 0

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  async encryptStringAsync(plainText: string): Promise<Buffer> {
    if (!this.available) throw new Error('locked')
    this.encryptCalls++
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.osKey, iv)
    const body = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()])
    return Buffer.concat([Buffer.from('v11'), iv, cipher.getAuthTag(), body])
  }

  async decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
    if (!this.available) throw new Error('locked')
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.osKey, encrypted.subarray(3, 15))
    decipher.setAuthTag(encrypted.subarray(15, 31))
    const result = Buffer.concat([decipher.update(encrypted.subarray(31)), decipher.final()]).toString('utf-8')
    return { result, shouldReEncrypt: this.reEncrypt }
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
    expect(safeStorage.encryptCalls).toBe(0)
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
    expect(safeStorage.encryptCalls).toBe(1)

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
    await expect(manager(new FakeSafeStorage()).key('browser-vault')).rejects.toMatchObject({ reason: 'secure-storage-unavailable' })
    expect(fs.readFileSync(wrappedFile(), 'utf-8')).toBe(before)
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

    // Another computer: its own OS store, the data copied over, the export as .vault-key.
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
})
