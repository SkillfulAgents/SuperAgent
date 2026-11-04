import fs from 'fs'
import path from 'path'
import { getDataDir } from '@shared/lib/config/data-dir'
import { writeFileAtomicSync } from '@shared/lib/utils/file-storage'
import { hostFileCreators } from './host-file-creators'

/**
 * Where the host keeps its small host files (a key, an id, a token map), by
 * file name. Reads are synchronous. Desktop keeps them as files in the data
 * dir. A deployment that serves requests on many processes installs a store
 * over its shared storage once at boot; that store must have the files loaded
 * before app code reads them.
 */
export interface HostFileStore {
  /** The file's text, or null when there is none. Read fresh. Throws on a read error other than an absent file. */
  read(name: string): string | null
  /** Read-modify-write of one file. A concurrent change is merged by applying `update` again. Returns the text written. */
  write(name: string, update: (current: string | null) => string): string
  /** Writes the whole file. A concurrent change fails the save instead of being overwritten. */
  replace(name: string, text: string): void
  /** The file's text. On first use it is made by its `defineHostFileCreator` creator; it is never rewritten. */
  getOrCreate(name: string): string
  /** `load()`, kept until the file is written or forgotten. */
  memo<T>(name: string, load: () => T): T
  /** Keeps `value` as the file's memo. */
  remember<T>(name: string, value: T): void
  /** Drops the file's memo. */
  forget(name: string): void
  /** Waits for queued saves. */
  flush(): Promise<void>
}

function filePath(name: string): string {
  return path.join(getDataDir(), name)
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

function writeFile(file: string, text: string): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  // Atomic and owner-only: host files hold API keys and tokens.
  writeFileAtomicSync(file, text, { mode: 0o600 })
}

/** Keyed by full path, so a changed data dir does not see another dir's values. */
const fileCache = new Map<string, unknown>()

/** Files in the data dir: one process owns them, so a read-modify-write is one synchronous step. */
export const dataDirHostFiles: HostFileStore = {
  read: (name) => readFile(filePath(name)),

  write(name, update) {
    const file = filePath(name)
    const next = update(readFile(file))
    writeFile(file, next)
    fileCache.delete(file)
    return next
  },

  replace(name, text) {
    const file = filePath(name)
    writeFile(file, text)
    fileCache.delete(file)
  },

  getOrCreate(name) {
    const file = filePath(name)
    const cached = fileCache.get(file)
    if (typeof cached === 'string') return cached
    let text = readFile(file)
    if (text === null) {
      const create = hostFileCreators().get(name)
      if (!create) throw new Error(`Host file "${name}" has no creator`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        // Exclusive: two processes starting at once keep one value, not two.
        fs.writeFileSync(file, create(), { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      text = readFile(file)
      if (text === null) throw new Error(`Host file "${name}" could not be read`)
    }
    fileCache.set(file, text)
    return text
  },

  memo<T>(name: string, load: () => T): T {
    const file = filePath(name)
    if (!fileCache.has(file)) fileCache.set(file, load())
    return fileCache.get(file) as T
  },

  remember(name, value) {
    fileCache.set(filePath(name), value)
  },

  forget(name) {
    fileCache.delete(filePath(name))
  },

  flush: async () => {},
}

let store: HostFileStore = dataDirHostFiles

export function hostFiles(): HostFileStore {
  return store
}

/** Installs the store once at boot. Desktop keeps the data dir files. */
export function setHostFileStore(next: HostFileStore): void {
  store = next
}
