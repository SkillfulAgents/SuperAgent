import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountSecretsSchema } from '@shared/lib/browser-vault/vault-schemas'
import { openJson, sealJson, VaultSealError } from '@shared/lib/browser-vault/vault-crypto'
import { installKeyManager, uninstallKeyManager } from './key-manager'
import { ServerKeyManager } from './server-key-manager'
import { FakeSealedData, memoryLog } from './testing/fake-probe'

let dataDir: string
let data: FakeSealedData
let log: ReturnType<typeof memoryLog>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-keys-'))
  data = new FakeSealedData()
  log = memoryLog()
})

afterEach(() => {
  uninstallKeyManager()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const keyFile = () => path.join(dataDir, '.vault-key')
const manager = (env: Record<string, string | undefined> = {}, dir = dataDir) =>
  new ServerKeyManager({ dataDir: dir, env, probes: data.probes, log })
const bytesOf = async (m: ServerKeyManager) => (await m.key('browser-vault')).export()
const binding = { purpose: 'account-secrets' as const, id: 'acc-1', site: 'github.com' }

/** Sealed the way the vault always has, under a raw key. */
function legacySeal(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(`${binding.purpose}\0${binding.id}\0${binding.site}`, 'utf-8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

describe('ServerKeyManager: a deployment secret', () => {
  it('uses the key the deployment sets, read once when the manager is made', async () => {
    const key = crypto.randomBytes(32)
    const env: Record<string, string | undefined> = { SUPERAGENT_VAULT_KEY: key.toString('base64') }
    const m = manager(env)
    env.SUPERAGENT_VAULT_KEY = crypto.randomBytes(32).toString('base64')
    expect((await bytesOf(m)).equals(key)).toBe(true)
    // Nothing written beside the database.
    expect(fs.readdirSync(dataDir)).toEqual([])
  })

  it('reads a mounted secret file', async () => {
    const key = crypto.randomBytes(32)
    const mount = path.join(dataDir, 'mounted-secret')
    fs.writeFileSync(mount, `${key.toString('base64')}\n`)
    expect((await bytesOf(manager({ SUPERAGENT_VAULT_KEY_FILE: mount }))).equals(key)).toBe(true)
  })

  it('refuses a setting that is not a key, or two settings, without falling back to the key file or quoting it', async () => {
    fs.writeFileSync(keyFile(), crypto.randomBytes(32).toString('base64'))
    const wrong = 'not-a-key-but-secret-looking'
    const bad = manager({ SUPERAGENT_VAULT_KEY: wrong })
    await expect(bad.key('browser-vault')).rejects.toMatchObject({ reason: 'misconfigured' })
    await bad.key('browser-vault').catch((error: Error) => expect(error.message).not.toContain(wrong))
    expect(log.lines.join('\n')).not.toContain(wrong)

    const both = manager({ SUPERAGENT_VAULT_KEY: crypto.randomBytes(32).toString('base64'), SUPERAGENT_VAULT_KEY_FILE: keyFile() })
    await expect(both.key('browser-vault')).rejects.toMatchObject({ reason: 'misconfigured' })
    await expect(manager({ SUPERAGENT_VAULT_KEY_FILE: path.join(dataDir, 'missing') }).key('browser-vault')).rejects.toMatchObject({ reason: 'misconfigured' })
  })

  it('refuses a key that does not open what is sealed, rather than sealing beside it', async () => {
    data.sealedUnder = crypto.randomBytes(32)
    const m = manager({ SUPERAGENT_VAULT_KEY: crypto.randomBytes(32).toString('base64') })
    await expect(m.key('browser-vault')).rejects.toMatchObject({ reason: 'mismatch' })
    data.sealedUnder = null
  })

  it('takes over from a legacy key file holding the same key, and says the file can go', async () => {
    const key = crypto.randomBytes(32)
    fs.writeFileSync(keyFile(), key.toString('base64'))
    data.sealedUnder = key
    expect((await bytesOf(manager({ SUPERAGENT_VAULT_KEY: key.toString('base64') }))).equals(key)).toBe(true)
    expect(log.lines.some((line) => line.includes('can be deleted'))).toBe(true)
  })
})

describe('ServerKeyManager: the data directory key file (installs that set no secret)', () => {
  it('opens what an install sealed before KeyManager, with its key file as it was', async () => {
    const key = crypto.randomBytes(32)
    const text = `${key.toString('base64')}\n`
    fs.writeFileSync(keyFile(), text)
    data.sealedUnder = key
    await installKeyManager(manager())
    await expect(openJson(legacySeal(JSON.stringify({ values: { password: 'old' } }), key), binding, accountSecretsSchema))
      .resolves.toEqual({ values: { password: 'old' } })
    expect(fs.readFileSync(keyFile(), 'utf-8')).toBe(text)
  })

  it('makes the key file on first use of a fresh install, owner-only, and not before', async () => {
    const m = manager()
    await m.initialize()
    expect(fs.readdirSync(dataDir)).toEqual([])
    const key = await bytesOf(m)
    expect(fs.readFileSync(keyFile(), 'utf-8')).toBe(key.toString('base64'))
    if (process.platform !== 'win32') expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600)
    // A restart, with another auth secret: the same key.
    expect((await bytesOf(manager({ BETTER_AUTH_SECRET: 'another-deployment-secret-of-32-chars!' }))).equals(key)).toBe(true)
  })

  it('never makes a key over sealed data: a missing key is reported, not replaced', async () => {
    data.sealedUnder = crypto.randomBytes(32)
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'missing' })
    expect(fs.existsSync(keyFile())).toBe(false)
  })

  it('never writes over a key file that holds no key', async () => {
    fs.writeFileSync(keyFile(), 'not a key')
    const m = manager()
    await m.initialize()
    await expect(m.key('browser-vault')).rejects.toMatchObject({ reason: 'corrupt' })
    expect(fs.readFileSync(keyFile(), 'utf-8')).toBe('not a key')
  })

  it('refuses a key file whose key does not open what is sealed', async () => {
    fs.writeFileSync(keyFile(), crypto.randomBytes(32).toString('base64'))
    data.sealedUnder = crypto.randomBytes(32)
    await expect(manager().key('browser-vault')).rejects.toMatchObject({ reason: 'mismatch' })
  })

  it('agrees on one key when first uses race, in one process or two', async () => {
    const one = manager()
    const keys = await Promise.all(Array.from({ length: 8 }, () => bytesOf(one)))
    expect(new Set(keys.map((key) => key.toString('base64'))).size).toBe(1)

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-keys-race-'))
    try {
      const raced = await Promise.all(Array.from({ length: 6 }, () => bytesOf(manager({}, otherDir))))
      expect(new Set(raced.map((key) => key.toString('base64'))).size).toBe(1)
      expect(fs.readFileSync(path.join(otherDir, '.vault-key'), 'utf-8')).toBe(raced[0].toString('base64'))
      expect(fs.readdirSync(otherDir)).toEqual(['.vault-key'])
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('retries a failure on the next call instead of remembering it', async () => {
    fs.writeFileSync(keyFile(), 'not a key')
    const m = manager()
    await expect(m.key('browser-vault')).rejects.toMatchObject({ reason: 'corrupt' })
    const key = crypto.randomBytes(32)
    fs.writeFileSync(keyFile(), key.toString('base64'))
    expect((await bytesOf(m)).equals(key)).toBe(true)
  })

  it('lets the app start when checking a key fails, and checks again on use', async () => {
    const key = crypto.randomBytes(32)
    fs.writeFileSync(keyFile(), key.toString('base64'))
    let databaseDown = true
    const m = new ServerKeyManager({
      dataDir,
      env: {},
      probes: { 'browser-vault': async () => { if (databaseDown) throw new Error('database down'); return 'nothing-sealed' } },
      log,
    })
    await expect(m.initialize()).resolves.toBeUndefined()
    await expect(m.key('browser-vault')).rejects.toThrow('database down')
    databaseDown = false
    expect((await bytesOf(m)).equals(key)).toBe(true)
  })

  it('keeps tenants apart: each scope its own key, and one\'s sealed values do not open in another', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-keys-tenant-'))
    try {
      const a = manager()
      const b = manager({}, otherDir)
      expect((await bytesOf(a)).equals(await bytesOf(b))).toBe(false)
      await installKeyManager(a)
      const sealed = await sealJson({ values: { password: 'a-only' } }, binding, accountSecretsSchema)
      uninstallKeyManager()
      await installKeyManager(b)
      await expect(openJson(sealed, binding, accountSecretsSchema)).rejects.toThrow(VaultSealError)
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('logs where the key is, never the key', async () => {
    const key = await bytesOf(manager())
    expect(log.lines.some((line) => line.includes('plaintext key file'))).toBe(true)
    expect(log.lines.join('\n')).not.toContain(key.toString('base64'))
  })
})
