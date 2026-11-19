import crypto from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { KeyUnavailableError } from '@shared/lib/keys/key-manager'
import { installTestKeyManager, uninstallKeyManager, type MemoryKeyManager } from '@shared/lib/keys/testing/memory-key-manager'
import { openJson, opensUnder, sealJson, VaultSealError } from './vault-crypto'
import { accountSecretsSchema, partKeyOf, sessionBundleSchema, type SessionBundle } from './vault-schemas'

let keys: MemoryKeyManager

beforeEach(async () => {
  keys = await installTestKeyManager()
})

afterEach(() => {
  uninstallKeyManager()
})

const binding = { purpose: 'account-secrets' as const, id: 'acc-1', site: 'github.com' }

/** A value sealed the way the vault always has (v1, before KeyManager), under a raw key. */
function legacySeal(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(`${binding.purpose}\0${binding.id}\0${binding.site}`, 'utf-8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

describe('vault sealing', () => {
  it('opens what it sealed, and nothing of it shows in the sealed text', async () => {
    const sealed = await sealJson({ values: { password: 'hunter2' } }, binding, accountSecretsSchema)
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/)
    expect(sealed).not.toContain('hunter2')
    await expect(openJson(sealed, binding, accountSecretsSchema)).resolves.toEqual({ values: { password: 'hunter2' } })
  })

  it('opens a value sealed before KeyManager under the same key', async () => {
    const key = crypto.randomBytes(32)
    keys.replaceKey('browser-vault', key)
    const sealed = legacySeal(JSON.stringify({ values: { password: 'old' } }), key)
    await expect(openJson(sealed, binding, accountSecretsSchema)).resolves.toEqual({ values: { password: 'old' } })
  })

  it('does not open under another key, and says the value did not open', async () => {
    const sealed = await sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)
    keys.replaceKey('browser-vault')
    await expect(openJson(sealed, binding, accountSecretsSchema)).rejects.toThrow(VaultSealError)
  })

  it('tells a key that cannot be had apart from a value that does not open', async () => {
    const sealed = await sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)
    keys.makeUnavailable(new KeyUnavailableError('browser-vault', 'secure-storage-unavailable', 'locked'))
    await expect(openJson(sealed, binding, accountSecretsSchema)).rejects.toBeInstanceOf(KeyUnavailableError)
    await expect(sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)).rejects.toBeInstanceOf(KeyUnavailableError)
  })

  it('says so when no KeyManager is installed, rather than picking a key itself', async () => {
    uninstallKeyManager()
    await expect(sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)).rejects.toMatchObject({
      name: 'KeyUnavailableError',
      reason: 'not-installed',
    })
  })

  it('checks a candidate key on a sealed value without opening it for anyone', async () => {
    const sealed = await sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)
    const current = await keys.key('browser-vault')
    expect(opensUnder(sealed, binding, current)).toBe(true)
    expect(opensUnder(sealed, binding, crypto.createSecretKey(crypto.randomBytes(32)))).toBe(false)
    expect(opensUnder(sealed, { ...binding, id: 'acc-2' }, current)).toBe(false)
    expect(opensUnder('garbage', binding, current)).toBe(false)
  })

  it('does not open a value sealed for another row, site or purpose', async () => {
    const sealed = await sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)
    for (const other of [
      { ...binding, id: 'acc-2' },
      { ...binding, site: 'evil.com' },
      { ...binding, purpose: 'account-session' as const },
    ]) {
      await expect(openJson(sealed, other, accountSecretsSchema)).rejects.toThrow(VaultSealError)
    }
  })

  it('refuses a tampered value or another format, saying nothing of the content', async () => {
    const sealed = await sealJson({ values: { password: 'hunter2' } }, binding, accountSecretsSchema)
    const [format, iv, tag, ciphertext] = sealed.split(':')
    const flipped = Buffer.from(ciphertext, 'base64')
    flipped[0] ^= 1
    await expect(openJson([format, iv, tag, flipped.toString('base64')].join(':'), binding, accountSecretsSchema)).rejects.toThrow(VaultSealError)
    await expect(openJson(`v2:${iv}:${tag}:${ciphertext}`, binding, accountSecretsSchema)).rejects.toThrow('Unsupported sealed value')
  })

  it('refuses a value of the wrong shape, sealing or opening, without quoting it', async () => {
    const messageOf = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return (error as Error).message
      }
      return ''
    }
    const wrong = { values: { password: 'hunter2' }, extra: 'x' }
    expect(await messageOf(() => sealJson(wrong as never, binding, accountSecretsSchema))).toBe('The value to seal has an unexpected shape')
    const sealed = await sealJson<unknown>(wrong, binding, z.unknown())
    expect(await messageOf(() => openJson(sealed, binding, accountSecretsSchema))).toBe('The sealed value has an unexpected shape')
    await expect(openJson(await sealJson<unknown>('x', binding, z.unknown()), binding, z.object({}))).rejects.toThrow(VaultSealError)
  })

  it('seals a saved session (part 3) like the secrets', async () => {
    const bundle = {
      version: 1 as const,
      site: 'github.com',
      capturedAt: '2026-10-23T00:00:00.000Z',
      cookies: [{ name: 'user_session', value: 'abc', domain: '.github.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const }],
      origins: [{ origin: 'https://github.com', localStorage: [['k', 'v']] as Array<[string, string]>, indexedDB: [] }],
    }
    const sessionBinding = { purpose: 'account-session' as const, id: 'session-1', site: 'github.com' }
    const sealed = await sealJson<SessionBundle>(bundle, sessionBinding, sessionBundleSchema)
    await expect(openJson(sealed, sessionBinding, sessionBundleSchema)).resolves.toEqual(bundle)
  })
})

describe('partKeyOf', () => {
  it('names a password and another field by label, and nothing else', () => {
    expect(partKeyOf({ kind: 'password', label: 'Password' })).toBe('password')
    expect(partKeyOf({ kind: 'text', label: ' Workspace  URL:* ' })).toBe('text:workspace url')
    expect(partKeyOf({ kind: 'username', label: 'Email' })).toBeNull()
    expect(partKeyOf({ kind: 'otp', label: 'Code' })).toBeNull()
    expect(partKeyOf({ kind: 'text', label: ' : ' })).toBeNull()
  })
})
