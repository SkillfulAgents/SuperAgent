/**
 * Where a chunked upload's bytes live, and nothing about the upload: AppState
 * holds what they mean (`chunked-upload.ts`). Desktop and web keep them on this
 * machine's disk. A deployment whose file system does not outlive a request
 * passes its blob store to `setUploadByteStore` at boot.
 */
import * as fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { getTempUploadsDir } from './file-storage'

export interface UploadByteStore {
  /** Stores `bytes` under `key`. A failure may leave part of them there. */
  put(key: string, bytes: Uint8Array): Promise<void>
  /** The bytes under `key` as a stream, or null when nothing is stored there. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>
  /** A missing key is a no-op. */
  delete(key: string): Promise<void>
  /** Every key that starts with `prefix`, with its size in bytes. */
  list(prefix: string): Promise<{ key: string; size: number }[]>
}

/** Every key an upload uses starts with this. */
export const UPLOAD_BYTES_PREFIX = 'uploads/'
/** Below the temp uploads dir: the local store's files. */
export const LOCAL_CHUNKS_DIR = 'chunks'
/** Tries at a put whose directory another upload's delete removed as it emptied. */
const PUT_ATTEMPTS = 5

function chunksDir(): string {
  return path.join(getTempUploadsDir(), LOCAL_CHUNKS_DIR)
}

function onDisk(key: string): string {
  const parts = key.startsWith(UPLOAD_BYTES_PREFIX) ? key.slice(UPLOAD_BYTES_PREFIX.length).split('/') : []
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`Invalid upload bytes key: ${key}`)
  }
  return path.join(chunksDir(), ...parts)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** The store that keeps bytes under this machine's temp uploads dir. */
export const localDiskUploadByteStore: UploadByteStore = {
  async put(key, bytes) {
    const file = onDisk(key)
    for (let attempt = 1; ; attempt++) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      try {
        await fs.promises.writeFile(file, bytes, { flag: 'wx' })
        return
      } catch (error) {
        if (!isMissing(error) || attempt >= PUT_ATTEMPTS) throw error
      }
    }
  },

  async stream(key) {
    try {
      const handle = await fs.promises.open(onDisk(key))
      return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },

  async delete(key) {
    const file = onDisk(key)
    try {
      await fs.promises.unlink(file)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    // Directories left empty go too; one still in use refuses, and that is fine.
    const root = chunksDir()
    for (let dir = path.dirname(file); dir !== root && dir.startsWith(root); dir = path.dirname(dir)) {
      try {
        await fs.promises.rmdir(dir)
      } catch {
        return
      }
    }
  },

  async list(prefix) {
    const root = chunksDir()
    let names: string[]
    try {
      names = await fs.promises.readdir(root, { recursive: true })
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const found: { key: string; size: number }[] = []
    for (const name of names) {
      const key = `${UPLOAD_BYTES_PREFIX}${name.split(path.sep).join('/')}`
      if (!key.startsWith(prefix)) continue
      try {
        const stat = await fs.promises.stat(path.join(root, name))
        if (stat.isFile()) found.push({ key, size: stat.size })
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return found
  },
}

let current: UploadByteStore = localDiskUploadByteStore

/** Set once at boot by a deployment with its own store. A test passes null to go back to disk. */
export function setUploadByteStore(store: UploadByteStore | null): void {
  current = store ?? localDiskUploadByteStore
}

export function uploadByteStore(): UploadByteStore {
  return current
}
