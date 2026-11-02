import fs from 'fs'
import path from 'path'

/**
 * Bytes by key that outlive this process, for a deployment whose file system does not: one
 * org's API on many short-lived isolates starts every request with an empty data dir. The
 * deployment sets the store once at boot. Desktop and the Node host never set one, and the
 * callers keep their files on disk as before.
 */
export interface BlobStore {
  /** The bytes under `key`, or null when nothing is stored there. */
  get(key: string): Promise<Uint8Array | null>
  put(key: string, bytes: Uint8Array): Promise<void>
  /** A missing key is a no-op. */
  delete(key: string): Promise<void>
  /** Every key that starts with `prefix`, with its size in bytes. */
  list(prefix: string): Promise<{ key: string; size: number }[]>
  /** The bytes under `key` as a stream, or null when nothing is stored there. */
  stream(key: string): Promise<ReadableStream<Uint8Array> | null>
}

let current: BlobStore | null = null

export function setBlobStore(store: BlobStore | null): void {
  current = store
}

export function blobStore(): BlobStore | null {
  return current
}

/** Small files kept by name in one folder: in the blob store when the deployment set one, else on disk. */
export interface HostFiles {
  /** The file's bytes, or null when there is no such file. */
  read(name: string): Promise<Uint8Array | null>
  /** Writes a new file; names are minted by the caller and never reused. */
  write(name: string, bytes: Uint8Array): Promise<void>
  /** A missing file is a no-op. */
  remove(name: string): Promise<void>
}

/** `prefix` names the folder in the blob store; `dir` is where the same files live on disk. */
export function hostFiles(prefix: string, dir: () => string): HostFiles {
  const checked = (name: string): string => {
    if (!name || name !== path.basename(name) || name === '..') throw new Error(`Invalid file name: ${name}`)
    return name
  }
  const key = (name: string) => `${prefix}/${checked(name)}`
  const onDisk = (name: string) => path.join(dir(), checked(name))
  return {
    async read(name) {
      const store = blobStore()
      if (store) return store.get(key(name))
      try {
        return await fs.promises.readFile(onDisk(name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async write(name, bytes) {
      const store = blobStore()
      if (store) return store.put(key(name), bytes)
      await fs.promises.mkdir(dir(), { recursive: true })
      await fs.promises.writeFile(onDisk(name), bytes, { mode: 0o600, flag: 'wx' })
    },
    async remove(name) {
      const store = blobStore()
      if (store) return store.delete(key(name))
      await fs.promises.unlink(onDisk(name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    },
  }
}
