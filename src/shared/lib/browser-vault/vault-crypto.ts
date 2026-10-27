import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { z } from 'zod'
import { getDataDir } from '@shared/lib/config/data-dir'
import { defineSingletonHostFile, hostFileKey, hostStateActive, readScoped } from '@shared/lib/host-state/scope'

/**
 * Sealing for the Browser Vault: AES-256-GCM under the vault's own key, 32
 * random bytes in `<data dir>/.vault-key` (owner-only), made on first use.
 * Not the auth secret: setting, rotating or resetting that (to sign everyone
 * out) never locks the vault. One file to keep with the database: restore
 * both and the vault opens; lose the key and nothing sealed does. An OS
 * keychain (Electron safeStorage) or a KMS can hold the key later. Each
 * sealed value is bound to the row and purpose it was written for, so a
 * ciphertext copied into another row or column does not open.
 */

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const FORMAT = 'v1'
const KEY_FILE = '.vault-key'

/** What a sealed value belongs to: bound in as additional authenticated data. */
export interface SealBinding {
  purpose: 'account-secrets' | 'account-session'
  /** The row's id. */
  id: string
  site: string
}

export class VaultSealError extends Error {}

/** The key file's contents, if it holds a key; null if there is none yet. Never regenerated over a key that may have sealed something. */
function readKeyFile(keyPath: string): Buffer | null {
  let text: string
  try {
    text = fs.readFileSync(keyPath, 'utf-8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new VaultSealError('The vault key could not be read')
  }
  const key = Buffer.from(text, 'base64')
  if (key.length !== KEY_BYTES) throw new VaultSealError(`The vault key file ${keyPath} does not hold a vault key`)
  return key
}

const keys = new Map<string, Buffer>()

defineSingletonHostFile(KEY_FILE, () => crypto.randomBytes(KEY_BYTES).toString('base64'))

function scopedVaultKey(): Buffer {
  const key = Buffer.from(readScoped(hostFileKey(KEY_FILE)) ?? '', 'base64')
  if (key.length !== KEY_BYTES) throw new VaultSealError('The stored vault key is not a vault key')
  return key
}

function vaultKey(): Buffer {
  if (hostStateActive()) return scopedVaultKey()
  const keyPath = path.join(getDataDir(), KEY_FILE)
  const cached = keys.get(keyPath)
  if (cached) return cached
  let key = readKeyFile(keyPath)
  if (!key) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true })
    try {
      // Exclusive: two processes starting at once keep one key, not two.
      fs.writeFileSync(keyPath, crypto.randomBytes(KEY_BYTES).toString('base64'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new VaultSealError('The vault key could not be saved')
    }
    key = readKeyFile(keyPath)
    if (!key) throw new VaultSealError('The vault key could not be read')
  }
  keys.set(keyPath, key)
  return key
}

function aad(binding: SealBinding): Buffer {
  return Buffer.from(`${binding.purpose}\0${binding.id}\0${binding.site}`, 'utf-8')
}

/** Seal a value of the given shape. Throws VaultSealError for another shape — never with the value in the message. */
export function sealJson<T>(value: T, binding: SealBinding, schema: z.ZodType<T>): string {
  const parsed = schema.safeParse(value)
  // The issues would quote the values: never pass them on.
  if (!parsed.success) throw new VaultSealError('The value to seal has an unexpected shape')
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(binding))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed.data), 'utf-8'), cipher.final()])
  return [FORMAT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

/**
 * Open a sealed value and check its shape. Throws VaultSealError for a value
 * that is not ours, was sealed for another row or under another key, or was
 * tampered with — never with the plaintext in the message.
 */
export function openJson<T>(stored: string, binding: SealBinding, schema: z.ZodType<T>): T {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT) throw new VaultSealError('Unsupported sealed value')
  const [, iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'))
  let plaintext: string
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad(binding))
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  } catch {
    throw new VaultSealError('The sealed value could not be opened')
  }
  let json: unknown
  try {
    json = JSON.parse(plaintext)
  } catch {
    throw new VaultSealError('The sealed value is not JSON')
  }
  const parsed = schema.safeParse(json)
  // The issues would quote the values: never pass them on.
  if (!parsed.success) throw new VaultSealError('The sealed value has an unexpected shape')
  return parsed.data
}

/** Test seam: forget derived keys (tests switch data directories and secrets). */
export function resetVaultKeyCache(): void {
  keys.clear()
}
