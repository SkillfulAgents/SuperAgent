/**
 * Key bytes and the files that hold them, shared by the KeyManager
 * implementations. Nothing here logs or returns a key in a message.
 */
import crypto, { type KeyObject } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { KeyPurpose } from './key-manager'

/** AES-256: every purpose's key is 32 bytes. */
export const KEY_BYTES = 32

export function generateKeyBytes(): Buffer {
  return crypto.randomBytes(KEY_BYTES)
}

export function toKeyObject(bytes: Buffer): KeyObject {
  return crypto.createSecretKey(bytes)
}

export function keyBytes(key: KeyObject): Buffer {
  return key.export()
}

export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * A key's check value: an HMAC of the purpose under the key. Stored beside a
 * wrapped key, it tells a key that unwrapped to the wrong bytes from the right
 * one without trying it on data. It reveals nothing of the key.
 */
export function keyCheckValue(bytes: Buffer, purpose: KeyPurpose): string {
  return crypto.createHmac('sha256', bytes).update(`gamut-key-check\0${purpose}`).digest().subarray(0, 16).toString('base64')
}

/** The text form every key file and key setting uses: base64 of the 32 bytes. */
export function encodeKey(bytes: Buffer): string {
  return bytes.toString('base64')
}

/** A key from its text form; null for anything that is not one. */
export function decodeKey(text: string): Buffer | null {
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null
  const bytes = Buffer.from(trimmed, 'base64')
  return bytes.length === KEY_BYTES ? bytes : null
}

export type KeyFileRead =
  | { state: 'absent' }
  | { state: 'key'; bytes: Buffer }
  /** The file is there but holds no key: never written over. */
  | { state: 'invalid' }
  | { state: 'unreadable'; code: string }

/** A plaintext key file (the legacy `.vault-key` format, and an exported key). */
export async function readKeyFile(filePath: string): Promise<KeyFileRead> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    return code === 'ENOENT' ? { state: 'absent' } : { state: 'unreadable', code }
  }
  const bytes = decodeKey(text)
  return bytes ? { state: 'key', bytes } : { state: 'invalid' }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeSynced(filePath: string, data: string, mode: number, flag: 'wx' | 'w'): Promise<void> {
  const handle = await fs.open(filePath, flag, mode)
  try {
    await handle.writeFile(data, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // `mode` applies only to a new file, and is masked by the umask.
  await fs.chmod(filePath, mode).catch(() => {})
}

function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
}

/**
 * Write a file only if there is none: written aside, then linked into place,
 * so a reader sees all of it or nothing and two writers keep one. 'exists'
 * when another writer got there first (read theirs).
 */
export async function writeFileExclusive(filePath: string, data: string, mode = 0o600): Promise<'created' | 'exists'> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = tempPathFor(filePath)
  await writeSynced(temp, data, mode, 'wx')
  try {
    await fs.link(temp, filePath)
    return 'created'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return 'exists'
    // A file system without hard links: an exclusive create still keeps one writer.
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS' || code === 'EXDEV') {
      try {
        await writeSynced(filePath, data, mode, 'wx')
        return 'created'
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
        throw fallbackError
      }
    }
    throw error
  } finally {
    await fs.unlink(temp).catch(() => {})
  }
}

/** Replace a file in one step (written aside, then renamed over it). */
export async function replaceFileAtomic(filePath: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temp = tempPathFor(filePath)
  try {
    await writeSynced(temp, data, mode, 'wx')
    await fs.rename(temp, filePath)
  } catch (error) {
    await fs.unlink(temp).catch(() => {})
    throw error
  }
}

/** Delete a file; one already gone is fine. */
export async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
