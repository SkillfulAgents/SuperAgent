import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { openJson, resetVaultKeyCache, sealJson, VaultSealError } from './vault-crypto'
import { accountSecretsSchema, partKeyOf, sessionBundleSchema, type SessionBundle } from './vault-schemas'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-crypto-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  // The data dir's own secret, as on a desktop install.
  vi.stubEnv('BETTER_AUTH_SECRET', '')
  resetVaultKeyCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetVaultKeyCache()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const binding = { purpose: 'account-secrets' as const, id: 'acc-1', site: 'github.com' }

describe('vault sealing', () => {
  it('opens what it sealed, and nothing of it shows in the sealed text', () => {
    const sealed = sealJson({ values: { password: 'hunter2' } }, binding, accountSecretsSchema)
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/)
    expect(sealed).not.toContain('hunter2')
    expect(openJson(sealed, binding, accountSecretsSchema)).toEqual({ values: { password: 'hunter2' } })
  })

  it('derives its key from the auth secret: the same secret opens it after a restart, another does not', () => {
    const sealed = sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)
    // No key file of its own: the auth secret is the one thing to keep.
    expect(fs.readdirSync(dataDir)).toEqual(['.auth-secret'])
    resetVaultKeyCache()
    expect(openJson(sealed, binding, accountSecretsSchema).values.password).toBe('a')

    vi.stubEnv('BETTER_AUTH_SECRET', 'another-deployment-secret-of-32-chars!')
    expect(() => openJson(sealed, binding, accountSecretsSchema)).toThrow(VaultSealError)
  })

  it('does not open a value sealed for another row, site or purpose', () => {
    const sealed = sealJson({ values: { password: 'a' } }, binding, accountSecretsSchema)
    for (const other of [
      { ...binding, id: 'acc-2' },
      { ...binding, site: 'evil.com' },
      { ...binding, purpose: 'account-session' as const },
    ]) {
      expect(() => openJson(sealed, other, accountSecretsSchema)).toThrow(VaultSealError)
    }
  })

  it('refuses a tampered value or another format, saying nothing of the content', () => {
    const sealed = sealJson({ values: { password: 'hunter2' } }, binding, accountSecretsSchema)
    const [format, iv, tag, ciphertext] = sealed.split(':')
    const flipped = Buffer.from(ciphertext, 'base64')
    flipped[0] ^= 1
    expect(() => openJson([format, iv, tag, flipped.toString('base64')].join(':'), binding, accountSecretsSchema)).toThrow(VaultSealError)
    expect(() => openJson(`v2:${iv}:${tag}:${ciphertext}`, binding, accountSecretsSchema)).toThrow('Unsupported sealed value')
  })

  it('refuses a value of the wrong shape, sealing or opening, without quoting it', () => {
    const messageOf = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        return (error as Error).message
      }
      return ''
    }
    const wrong = { values: { password: 'hunter2' }, extra: 'x' }
    expect(messageOf(() => sealJson(wrong as never, binding, accountSecretsSchema))).toBe('The value to seal has an unexpected shape')
    const sealed = sealJson<unknown>(wrong, binding, z.unknown())
    expect(messageOf(() => openJson(sealed, binding, accountSecretsSchema))).toBe('The sealed value has an unexpected shape')
    expect(() => openJson(sealJson<unknown>('x', binding, z.unknown()), binding, z.object({}))).toThrow(VaultSealError)
  })

  it('seals a saved session (part 3) like the secrets', () => {
    const bundle = {
      version: 1 as const,
      site: 'github.com',
      capturedAt: '2026-10-23T00:00:00.000Z',
      cookies: [{ name: 'user_session', value: 'abc', domain: '.github.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const }],
      origins: [{ origin: 'https://github.com', localStorage: [['k', 'v']] as Array<[string, string]>, indexedDB: [], unsupported: [] }],
    }
    const sessionBinding = { purpose: 'account-session' as const, id: 'session-1', site: 'github.com' }
    expect(openJson(sealJson<SessionBundle>(bundle, sessionBinding, sessionBundleSchema), sessionBinding, sessionBundleSchema)).toEqual(bundle)
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
