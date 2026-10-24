import crypto from 'crypto'
import type { z } from 'zod'
import { getOrCreateAuthSecret } from '@shared/lib/auth/secret'

/**
 * Sealing for the Browser Vault: AES-256-GCM under a key derived from the
 * deployment's auth secret, as the S3 volume credentials are (an OS keychain
 * or a KMS can replace it later). One secret to keep: restore the database
 * with it and the vault opens; lose it and nothing sealed does. Each sealed
 * value is bound to the row and purpose it was written for, so a ciphertext
 * copied into another row or column does not open.
 */

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const FORMAT = 'v1'

/** What a sealed value belongs to: bound in as additional authenticated data. */
export interface SealBinding {
  purpose: 'account-secrets' | 'account-session'
  /** The row's id. */
  id: string
  site: string
}

export class VaultSealError extends Error {}

const keys = new Map<string, Buffer>()

function vaultKey(): Buffer {
  const secret = getOrCreateAuthSecret()
  let key = keys.get(secret)
  if (!key) {
    key = Buffer.from(crypto.hkdfSync('sha256', secret, 'gamut-browser-vault', 'account-secrets-v1', KEY_BYTES))
    keys.set(secret, key)
  }
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
