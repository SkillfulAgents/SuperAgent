import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getDataDir } from '@shared/lib/config/data-dir'
import {
  siteStorageBundleSchema,
  type SiteStorageBundle,
} from '../../../../agent-container/src/browser-storage-bundle'

const KEY_FILENAME = 'browser-vault.key'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const FORMAT = 'v1'

/** Identifies the credential row a ciphertext belongs to; bound in as AAD. */
export interface BrowserVaultRow {
  id: string
  site: string
}

function readKey(keyPath: string): Buffer {
  const key = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'base64')
  if (key.length !== KEY_BYTES) throw new Error(`${KEY_FILENAME} is not a ${KEY_BYTES}-byte key`)
  return key
}

// Never overwrites an existing key: replacing it would make every saved login undecryptable.
function getOrCreateKey(): Buffer {
  const dataDir = getDataDir()
  const keyPath = path.join(dataDir, KEY_FILENAME)
  if (fs.existsSync(keyPath)) return readKey(keyPath)

  const key = crypto.randomBytes(KEY_BYTES)
  fs.mkdirSync(dataDir, { recursive: true })
  try {
    fs.writeFileSync(keyPath, key.toString('base64'), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readKey(keyPath)
    throw error
  }
  return key
}

function aad(row: BrowserVaultRow): Buffer {
  return Buffer.from(`${row.id}\0${row.site}`, 'utf-8')
}

export function encryptBrowserBundle(bundle: SiteStorageBundle, row: BrowserVaultRow): string {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', getOrCreateKey(), iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(row))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf-8'), cipher.final()])
  return [FORMAT, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decryptBrowserBundle(stored: string, row: BrowserVaultRow): SiteStorageBundle {
  const parts = stored.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT) throw new Error('Unsupported browser credential format')
  const [, iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'))

  const decipher = crypto.createDecipheriv('aes-256-gcm', getOrCreateKey(), iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(aad(row))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
  return siteStorageBundleSchema.parse(JSON.parse(plaintext))
}
