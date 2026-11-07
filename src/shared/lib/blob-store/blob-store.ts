import fs from 'fs'
import path from 'path'
import { getDataDir } from '@shared/lib/config/data-dir'

/**
 * Bytes by key that outlive this process. Desktop and the Node host keep them in the data dir,
 * where the same files lived before. A deployment whose file system does not outlive a request
 * passes its own store to `setBlobStore` at boot.
 */
export interface BlobStore {
  /** The bytes under `key`, or null when nothing is stored there. */
  get(key: string): Promise<Uint8Array | null>
  /** Stores `bytes` under `key`, replacing what was there. */
  put(key: string, bytes: Uint8Array): Promise<void>
  /** A missing key is a no-op. */
  delete(key: string): Promise<void>
}

/** Keeps each key as a file below `root`: key `model-icons/a.svg` is `<root>/model-icons/a.svg`. */
export class FileSystemBlobStore implements BlobStore {
  constructor(private readonly root: () => string) {}

  private file(key: string): string {
    const parts = key.split('/')
    if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
      throw new Error(`Invalid blob key: ${key}`)
    }
    return path.join(this.root(), ...parts)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await fs.promises.readFile(this.file(key))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.file(key)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, bytes, { mode: 0o600 })
  }

  async delete(key: string): Promise<void> {
    await fs.promises.unlink(this.file(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

const dataDirBlobStore = new FileSystemBlobStore(getDataDir)
let current: BlobStore = dataDirBlobStore

/** Set once at boot by a deployment with its own store. A test passes null to go back to the data dir. */
export function setBlobStore(store: BlobStore | null): void {
  current = store ?? dataDirBlobStore
}

export function blobStore(): BlobStore {
  return current
}

/** Small files kept by name under one key prefix in the blob store. */
export interface HostFiles {
  /** The file's bytes, or null when there is no such file. */
  read(name: string): Promise<Uint8Array | null>
  /** Writes a new file; names are minted by the caller and never reused. */
  write(name: string, bytes: Uint8Array): Promise<void>
  /** A missing file is a no-op. */
  remove(name: string): Promise<void>
}

export function hostFiles(prefix: string): HostFiles {
  const key = (name: string): string => {
    if (!name || name !== path.basename(name) || name === '.' || name === '..') throw new Error(`Invalid file name: ${name}`)
    return `${prefix}/${name}`
  }
  return {
    read: async (name) => blobStore().get(key(name)),
    write: async (name, bytes) => blobStore().put(key(name), bytes),
    remove: async (name) => blobStore().delete(key(name)),
  }
}
