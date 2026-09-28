import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SiteStorageBundle } from '../../../../agent-container/src/browser-storage-bundle'
import { decryptBrowserBundle, encryptBrowserBundle } from './browser-vault-crypto'

const row = { id: 'bc_1', site: 'example.com' }
const bundle: SiteStorageBundle = {
  version: 1,
  site: 'example.com',
  capturedAt: '2026-09-28T00:00:00.000Z',
  cookies: [],
  origins: [{ origin: 'https://example.com', localStorage: [['theme', 'dark']], indexedDB: [], unsupported: [] }],
}

describe('browser vault crypto', () => {
  let dataDir: string
  const previousDataDir = process.env.SUPERAGENT_DATA_DIR

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-vault-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('round-trips a bundle without exposing its contents', () => {
    const stored = encryptBrowserBundle(bundle, row)
    expect(stored.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain('dark')
    expect(decryptBrowserBundle(stored, row)).toEqual(bundle)
  })

  it('creates one owner-only key and reuses it', () => {
    const stored = encryptBrowserBundle(bundle, row)
    const keyPath = path.join(dataDir, 'browser-vault.key')
    const key = fs.readFileSync(keyPath, 'utf-8')
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600)

    encryptBrowserBundle(bundle, row)
    expect(fs.readFileSync(keyPath, 'utf-8')).toBe(key)
    expect(decryptBrowserBundle(stored, row)).toEqual(bundle)
  })

  it('rejects ciphertext moved to another row', () => {
    const stored = encryptBrowserBundle(bundle, row)
    expect(() => decryptBrowserBundle(stored, { ...row, id: 'bc_2' })).toThrow()
    expect(() => decryptBrowserBundle(stored, { ...row, site: 'other.com' })).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const [format, iv, tag, ciphertext] = encryptBrowserBundle(bundle, row).split(':')
    const bytes = Buffer.from(ciphertext, 'base64')
    bytes[0] ^= 1
    expect(() => decryptBrowserBundle([format, iv, tag, bytes.toString('base64')].join(':'), row)).toThrow()
  })

  it('rejects unknown formats', () => {
    expect(() => decryptBrowserBundle('v2:a:b:c', row)).toThrow('Unsupported browser credential format')
  })

  it('refuses to replace a malformed key', () => {
    fs.writeFileSync(path.join(dataDir, 'browser-vault.key'), 'short')
    expect(() => encryptBrowserBundle(bundle, row)).toThrow('not a 32-byte key')
  })
})
