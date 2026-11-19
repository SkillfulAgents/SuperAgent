import crypto, { type KeyObject } from 'crypto'
import type { z } from 'zod'
import { keyFor } from '@shared/lib/keys/key-manager'

/**
 * Sealing for the Browser Vault: AES-256-GCM under the vault's own key, which
 * the installed KeyManager holds (`src/shared/lib/keys/`): the OS keychain on
 * desktop, a deployment secret or the data directory's key file on a server.
 * Nothing here knows where. Not the auth secret: setting, rotating or
 * resetting that (to sign everyone out) never locks the vault. Each sealed
 * value is bound to the row and purpose it was written for, so a ciphertext
 * copied into another row or column does not open.
 *
 * A key the manager cannot hand out rejects with its KeyUnavailableError,
 * not VaultSealError: "this value does not open" and "the vault is locked
 * here" are told apart by every caller.
 */

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

function vaultKey(): Promise<KeyObject> {
  return keyFor('browser-vault')
}

function aad(binding: SealBinding): Buffer {
  return Buffer.from(`${binding.purpose}\0${binding.id}\0${binding.site}`, 'utf-8')
}

/** Seal a value of the given shape. Throws VaultSealError for another shape — never with the value in the message. */
export async function sealJson<T>(value: T, binding: SealBinding, schema: z.ZodType<T>): Promise<string> {
  const parsed = schema.safeParse(value)
  // The issues would quote the values: never pass them on.
  if (!parsed.success) throw new VaultSealError('The value to seal has an unexpected shape')
  const key = await vaultKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(binding))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed.data), 'utf-8'), cipher.final()])
  return [FORMAT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

/** The plaintext of a sealed value under `key`; VaultSealError when it is not ours or does not open. */
function decrypt(stored: string, binding: SealBinding, key: KeyObject): string {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT) throw new VaultSealError('Unsupported sealed value')
  const [, iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'))
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad(binding))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  } catch {
    throw new VaultSealError('The sealed value could not be opened')
  }
}

/**
 * Open a sealed value and check its shape. Throws VaultSealError for a value
 * that is not ours, was sealed for another row or under another key, or was
 * tampered with — never with the plaintext in the message.
 */
export async function openJson<T>(stored: string, binding: SealBinding, schema: z.ZodType<T>): Promise<T> {
  const plaintext = decrypt(stored, binding, await vaultKey())
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

/** Whether a sealed value opens under a candidate key (its tag checks out): for verifying a key before it is used. */
export function opensUnder(stored: string, binding: SealBinding, key: KeyObject): boolean {
  try {
    decrypt(stored, binding, key)
    return true
  } catch {
    return false
  }
}
