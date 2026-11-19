/**
 * One agent's saved workspace: its files while no container holds them. Each file's bytes are in
 * R2 under their content hash, and the list of files (path, hash, size, mode) is in the agent
 * object's SQLite. A small file written while the agent sleeps is held in that SQLite until it is
 * in R2 (`workspace_held`). Bytes stored in R2 before a file uses them are marked pending
 * (`workspace_pending`), so a save or write that fails leaves nothing behind.
 *
 * This class reads and changes that record. Its owner, AgentDurableObject, decides when a change
 * may happen: one at a time, and only while the agent's container does not hold the files.
 */
import type { DurableObjectStorage, R2Bucket } from 'cloudflare:workers'
import type { ByteRange, StoredEntry } from '../cloudflare-container-control'

/** A file up to this size written while the agent sleeps is answered from the object's storage before it is in R2. */
const HELD_MAX_BYTES = 256 * 1024
// Modes of a file and of a folder first made while the agent sleeps.
const NEW_FILE_MODE = 0o644
const NEW_FOLDER_MODE = 0o755
// R2 deletes at most 1,000 keys per call.
const DELETE_BATCH = 1000
// Links followed in a row before a path counts as not found, as a filesystem gives up on a loop.
const MAX_LINK_HOPS = 8

// A type, not an interface: SQL row types must be assignable to Record<string, SqlStorageValue>.
export type WorkspaceFile = {
  path: string
  /** Empty for a symlink or a folder. */
  hash: string
  size: number
  mode: number
  mtimeMs?: number
  /** A 'dir' row is a folder with nothing in it. */
  kind?: 'file' | 'symlink' | 'dir'
  /** A symlink's target. */
  target?: string | null
}

/** What the container answers once it uploaded the bytes a save asked for. */
export type UploadResult = { changed: WorkspaceFile[]; skipped: string[]; removed: string[] }

/** The bounds of the paths under a folder: `/` sorts right before `0`, so they are the keys from `rel/` up to `rel0`. */
const under = (rel: string): [string, string] => [`${rel}/`, `${rel}0`]

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Where one agent's file bytes are kept: one object per content hash. */
export function workspaceBlobKey(objectId: string, hash: string): string {
  return `agents/${objectId}/blobs/${hash}`
}

export class SavedWorkspace {
  private readonly sql: DurableObjectStorage['sql']

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket,
    private readonly objectId: string,
  ) {
    const sql = (this.sql = storage.sql)
    sql.exec("CREATE TABLE IF NOT EXISTS workspace_file (path TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, mode INTEGER NOT NULL, mtime INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'file', target TEXT)")
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)')
    // File bytes stored in R2 but not yet in the file list: a save or write that fails leaves them behind.
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_pending (hash TEXT PRIMARY KEY)')
    // Bytes of a small file written while the agent sleeps, kept here until they are in R2 (write).
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_held (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)')
  }

  /** True while bytes are held here that are not in R2 yet. */
  hasHeldBytes(): boolean {
    return this.sql.exec('SELECT 1 FROM workspace_held LIMIT 1').toArray().length > 0
  }

  /** A file, a folder's children, or null when neither exists. A link to a file reads as that file, at the link's path. */
  entry(rel: string): StoredEntry | StoredEntry[] | null {
    const linked = this.linkedFile(rel)
    if (linked) return { ...linked.entry, name: rel.slice(rel.lastIndexOf('/') + 1), path: rel }
    const sql = this.sql
    // Links are not listed while asleep; one is read through to its file (linkedFile).
    type Row = { path: string; size: number; mtime: number; kind: string }
    const file = sql.exec<Row>("SELECT path, size, mtime, kind FROM workspace_file WHERE path = ? AND kind != 'symlink'", rel).toArray()[0]
    if (file?.kind === 'file') return fileEntry(file)
    const prefix = rel ? `${rel}/` : ''
    // By key range, so a folder's listing reads its own rows and not the whole file list.
    const rows = rel
      ? sql.exec<Row>("SELECT path, size, mtime, kind FROM workspace_file WHERE path >= ? AND path < ? AND kind != 'symlink'", ...under(rel)).toArray()
      : sql.exec<Row>("SELECT path, size, mtime, kind FROM workspace_file WHERE kind != 'symlink'").toArray()
    if (rows.length === 0 && rel && !file) return null
    const children = new Map<string, StoredEntry>()
    for (const row of rows) {
      const rest = row.path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) children.set(row.path, row.kind === 'dir' ? { name: rest, path: row.path, type: 'directory' } : fileEntry(row))
      else children.set(prefix + rest.slice(0, slash), { name: rest.slice(0, slash), path: prefix + rest.slice(0, slash), type: 'directory' })
    }
    return [...children.values()]
  }

  // Streamed, not read whole: a large file would not fit in the object's memory.
  async read(rel: string, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> } | null> {
    const path = this.linkedFile(rel)?.path ?? rel
    const row = this.sql.exec<{ hash: string; size: number }>("SELECT hash, size FROM workspace_file WHERE path = ? AND kind = 'file'", path).toArray()[0]
    if (!row) return null
    // A range that starts at or past the end reads nothing, and one that ends past it stops at the end, as a file read does.
    if (range && range.start >= row.size) return { size: row.size, stream: new ReadableStream({ start: (controller) => controller.close() }) }
    const r2Range = range && { offset: range.start, ...(range.end === undefined ? {} : { length: Math.min(range.end, row.size - 1) - range.start + 1 }) }
    const held = this.sql.exec<{ bytes: ArrayBuffer }>('SELECT bytes FROM workspace_held WHERE hash = ?', row.hash).toArray()[0]
    if (held) {
      const bytes = new Uint8Array(held.bytes)
      const part = range ? bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : bytes
      return { size: row.size, stream: new Response(part).body! }
    }
    const object = await this.bucket.get(this.blobKey(row.hash), r2Range ? { range: r2Range } : undefined)
    return object ? { size: row.size, stream: object.body } : null
  }

  /**
   * The file a link at `rel` leads to, following links in a row, when it ends at a file inside the
   * workspace. Null for anything else: no link there, a link out of the workspace, to a folder, or a loop.
   */
  private linkedFile(rel: string): { path: string; entry: StoredEntry } | null {
    let path = rel
    for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
      type Row = { path: string; size: number; mtime: number; kind: string; target: string | null }
      const row = this.sql.exec<Row>('SELECT path, size, mtime, kind, target FROM workspace_file WHERE path = ?', path).toArray()[0]
      if (!row) return null
      if (row.kind === 'file') return path === rel ? null : { path, entry: fileEntry(row) }
      if (row.kind !== 'symlink' || !row.target) return null
      const next = linkTarget(path, row.target)
      if (next === null) return null
      path = next
    }
    return null
  }

  /** Writes one file. Returns the hashes it replaced, for the caller to settle. */
  async write(rel: string, bytes: Uint8Array): Promise<string[]> {
    // As the agent's disk would refuse it: the saved workspace cannot hold a file and a folder at one path.
    const parent = this.nonFolderParent(rel)
    if (parent) throw new Error(`Cannot write ${rel}: ${parent} is not a folder`)
    const sql = this.sql
    const isFolder = sql.exec("SELECT 1 FROM workspace_file WHERE (path = ? AND kind = 'dir') OR (path >= ? AND path < ?) LIMIT 1", rel, ...under(rel)).toArray().length > 0
    if (isFolder) throw new Error(`Cannot write ${rel}: it is a folder`)
    const hash = hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
    this.markPending([hash])
    // An R2 write takes about half a second. A small file is kept in the object's own storage,
    // which is as durable and takes a millisecond, and goes to R2 after the caller has its answer.
    if (bytes.byteLength <= HELD_MAX_BYTES) sql.exec('INSERT OR REPLACE INTO workspace_held (hash, bytes) VALUES (?, ?)', hash, bytes.slice().buffer)
    else await this.bucket.put(this.blobKey(hash), bytes)
    const previous = sql.exec<{ mode: number }>('SELECT mode FROM workspace_file WHERE path = ?', rel).toArray()[0]
    return this.record([{ path: rel, hash, size: bytes.byteLength, mode: previous?.mode ?? NEW_FILE_MODE, mtimeMs: Date.now(), kind: 'file' }])
  }

  /** Adds bytes to the end of a file, or makes it. Returns the hashes it replaced, for the caller to settle. */
  async append(rel: string, bytes: Uint8Array): Promise<string[]> {
    const current = await this.read(rel)
    const before = current ? new Uint8Array(await new Response(current.stream).arrayBuffer()) : new Uint8Array()
    const next = new Uint8Array(before.byteLength + bytes.byteLength)
    next.set(before)
    next.set(bytes, before.byteLength)
    return this.write(rel, next)
  }

  /** Keeps an empty folder, unless something is already at the path or under it. */
  mkdir(rel: string): void {
    const parent = this.nonFolderParent(rel)
    if (parent) throw new Error(`Cannot make the folder ${rel}: ${parent} is not a folder`)
    const taken = this.sql.exec('SELECT 1 FROM workspace_file WHERE path = ? OR (path >= ? AND path < ?) LIMIT 1', rel, ...under(rel)).toArray().length > 0
    if (!taken) this.record([{ path: rel, hash: '', size: 0, mode: NEW_FOLDER_MODE, mtimeMs: Date.now(), kind: 'dir' }])
  }

  /** Removes a file, or a folder with everything under it, from the file list. Returns their hashes, for the caller to drop. */
  remove(rel: string): string[] {
    const sql = this.sql
    const match = 'path = ? OR (path >= ? AND path < ?)'
    const hashes = sql.exec<{ hash: string }>(`SELECT DISTINCT hash FROM workspace_file WHERE ${match}`, rel, ...under(rel)).toArray().map((row) => row.hash)
    if (hashes.length === 0) return []
    this.storage.transactionSync(() => {
      sql.exec(`DELETE FROM workspace_file WHERE ${match}`, rel, ...under(rel))
      this.bumpVersion()
    })
    return hashes
  }

  /** Sets these entries in the file list. Returns the hashes they replaced, for the caller to drop. */
  record(files: WorkspaceFile[]): string[] {
    const sql = this.sql
    const replaced: string[] = []
    this.storage.transactionSync(() => {
      for (const file of files) {
        replaced.push(...this.clearConflicts(file))
        const previous = sql.exec<{ hash: string }>('SELECT hash FROM workspace_file WHERE path = ?', file.path).toArray()[0]
        if (previous?.hash && previous.hash !== file.hash) replaced.push(previous.hash)
        sql.exec(
          'INSERT INTO workspace_file (path, hash, size, mode, mtime, kind, target) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET hash = excluded.hash, size = excluded.size, mode = excluded.mode, mtime = excluded.mtime, kind = excluded.kind, target = excluded.target',
          file.path, file.hash, file.size, file.mode, Math.round(file.mtimeMs ?? 0), file.kind ?? 'file', file.target ?? null,
        )
      }
      this.bumpVersion()
    })
    return replaced
  }

  /** Replaces the whole file list with what a full save found. Returns the new version. */
  replaceAll(files: WorkspaceFile[]): number {
    const sql = this.sql
    const version = this.version() + 1
    this.storage.transactionSync(() => {
      sql.exec('DELETE FROM workspace_file')
      for (const file of files) {
        sql.exec(
          'INSERT INTO workspace_file (path, hash, size, mode, mtime, kind, target) VALUES (?, ?, ?, ?, ?, ?, ?)',
          file.path, file.hash, file.size, file.mode, Math.round(file.mtimeMs ?? 0), file.kind ?? 'file', file.target ?? null,
        )
      }
      sql.exec('INSERT INTO workspace_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version', version)
    })
    return version
  }

  /** The whole file list, as a restore sends it to the container. */
  files(): WorkspaceFile[] {
    return this.sql.exec<WorkspaceFile>('SELECT path, hash, size, mode, mtime AS mtimeMs, kind, target FROM workspace_file').toArray()
  }

  /** The hashes the saved files use. */
  storedHashes(): string[] {
    return this.sql.exec<{ hash: string }>("SELECT DISTINCT hash FROM workspace_file WHERE kind = 'file'").toArray().map((row) => row.hash)
  }

  /** Marks bytes that are, or are about to be, in R2 before a file uses them. */
  markPending(hashes: string[]): void {
    for (const hash of hashes) this.sql.exec('INSERT OR IGNORE INTO workspace_pending (hash) VALUES (?)', hash)
  }

  /**
   * Hashes of these files whose bytes this store cannot vouch for: no saved file uses them, and the
   * container has not uploaded them since it was asked. They are marked pending before the
   * container uploads them, so bytes no file ends up using are dropped (settlePending). An upload
   * counts only while its hash is still pending: a save may have dropped the bytes meanwhile.
   * Checked here, not in R2: one R2 request per new file made a save of many files take tens of seconds.
   */
  missingBlobs(files: WorkspaceFile[], uploaded: string[]): string[] {
    const sql = this.sql
    const sent = new Set(uploaded)
    const used = (hash: string) => sql.exec('SELECT 1 FROM workspace_file WHERE hash = ? LIMIT 1', hash).toArray().length > 0
    const pending = (hash: string) => sql.exec('SELECT 1 FROM workspace_pending WHERE hash = ?', hash).toArray().length > 0
    const hashes = [...new Set(files.filter((file) => (file.kind ?? 'file') === 'file').map((file) => file.hash))]
    const missing = hashes.filter((hash) => !used(hash) && !(sent.has(hash) && pending(hash)))
    this.markPending(missing)
    return missing
  }

  /** A file that changed during upload gets its new hash; one that kept changing keeps its previous saved version. */
  applyUpload(files: WorkspaceFile[], uploaded: UploadResult): WorkspaceFile[] {
    const changed = new Map(uploaded.changed.map((file) => [file.path, file]))
    const removed = new Set(uploaded.removed)
    const skipped = new Set(uploaded.skipped)
    const previous = (path: string) =>
      this.sql.exec<WorkspaceFile>("SELECT path, hash, size, mode, mtime AS mtimeMs, kind, target FROM workspace_file WHERE path = ? AND kind = 'file'", path).toArray()[0]
    return files.flatMap((file) => {
      if (removed.has(file.path)) return []
      if (skipped.has(file.path)) return previous(file.path) ?? []
      return [changed.get(file.path) ?? file]
    })
  }

  /** Writes held bytes to R2, then lets go of them. Bytes no file uses any more are only let go of. */
  async uploadHeld(): Promise<void> {
    const sql = this.sql
    const held = sql.exec<{ hash: string }>('SELECT hash FROM workspace_held').toArray().map((row) => row.hash)
    await Promise.all(held.map(async (hash) => {
      if (sql.exec('SELECT 1 FROM workspace_file WHERE hash = ? LIMIT 1', hash).toArray().length > 0) {
        const { bytes } = sql.exec<{ bytes: ArrayBuffer }>('SELECT bytes FROM workspace_held WHERE hash = ?', hash).toArray()[0]
        await this.bucket.put(this.blobKey(hash), bytes)
      }
      sql.exec('DELETE FROM workspace_held WHERE hash = ?', hash)
    }))
  }

  /** Deletes the bytes of the given hashes that no file uses any more; returns how many. */
  async dropUnreferenced(hashes: string[]): Promise<number> {
    const sql = this.sql
    const unused = hashes.filter((hash) => hash && sql.exec('SELECT 1 FROM workspace_file WHERE hash = ? LIMIT 1', hash).toArray().length === 0)
    for (let i = 0; i < unused.length; i += DELETE_BATCH) await this.bucket.delete(unused.slice(i, i + DELETE_BATCH).map((hash) => this.blobKey(hash)))
    return unused.length
  }

  /** Ends the wait of every pending hash: bytes a file now uses are kept, and the rest are deleted from R2. */
  async settlePending(): Promise<void> {
    const sql = this.sql
    const pending = sql.exec<{ hash: string }>('SELECT hash FROM workspace_pending').toArray().map((row) => row.hash)
    if (pending.length === 0) return
    await this.dropUnreferenced(pending)
    for (const hash of pending) sql.exec('DELETE FROM workspace_pending WHERE hash = ?', hash)
  }

  /** Deletes everything saved: the agent's files in R2 and its file list. */
  async purge(): Promise<void> {
    const prefix = `agents/${this.objectId}/`
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor })
      if (page.objects.length > 0) await this.bucket.delete(page.objects.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    const sql = this.sql
    this.storage.transactionSync(() => {
      for (const table of ['workspace_file', 'workspace_meta', 'workspace_pending', 'workspace_held']) sql.exec(`DELETE FROM ${table}`)
    })
  }

  /** The nearest folder above `rel` that the saved workspace holds as a file or a link; null when there is none. */
  private nonFolderParent(rel: string): string | null {
    const parts = rel.split('/')
    for (let depth = parts.length - 1; depth > 0; depth--) {
      const parent = parts.slice(0, depth).join('/')
      if (this.sql.exec("SELECT 1 FROM workspace_file WHERE path = ? AND kind != 'dir'", parent).toArray().length > 0) return parent
    }
    return null
  }

  /**
   * Removes the saved entries a new entry cannot share a workspace with: a file or link where one
   * of its folders is, and everything under a path that is now a file or a link. A path can change
   * between a file and a folder inside one batch of changes, and a list that kept both would fail
   * every later restore. Returns the hashes of what it removed, for the caller to drop.
   */
  private clearConflicts(file: WorkspaceFile): string[] {
    const sql = this.sql
    const hashes: string[] = []
    for (let parent = this.nonFolderParent(file.path); parent; parent = this.nonFolderParent(file.path)) {
      hashes.push(...sql.exec<{ hash: string }>('SELECT hash FROM workspace_file WHERE path = ?', parent).toArray().map((row) => row.hash))
      sql.exec('DELETE FROM workspace_file WHERE path = ?', parent)
    }
    if ((file.kind ?? 'file') !== 'dir') {
      hashes.push(...sql.exec<{ hash: string }>('SELECT DISTINCT hash FROM workspace_file WHERE path >= ? AND path < ?', ...under(file.path)).toArray().map((row) => row.hash))
      sql.exec('DELETE FROM workspace_file WHERE path >= ? AND path < ?', ...under(file.path))
    }
    return hashes.filter((hash) => hash !== '')
  }

  private version(): number {
    return this.sql.exec<{ version: number }>('SELECT version FROM workspace_meta WHERE id = 1').toArray()[0]?.version ?? 0
  }

  private bumpVersion(): void {
    this.sql.exec('INSERT INTO workspace_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version', this.version() + 1)
  }

  private blobKey(hash: string): string {
    return workspaceBlobKey(this.objectId, hash)
  }
}

const HASH = /^[0-9a-f]{64}$/
const KINDS: readonly unknown[] = ['file', 'symlink', 'dir']
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)

export function isList<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(isItem)
}

/** A path inside the workspace: relative, with no empty, `.` or `..` part. */
export function isWorkspacePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/** One entry of a save, as the cf-workspace-server sends it; restore writes each one under /workspace. */
export function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Record<string, unknown>
  const kind = file.kind ?? 'file'
  if (!isWorkspacePath(file.path) || !KINDS.includes(kind) || !isCount(file.size) || !isCount(file.mode) || file.mode > 0o7777) return false
  if (file.mtimeMs !== undefined && typeof file.mtimeMs !== 'number') return false
  if (kind === 'symlink') return typeof file.target === 'string' && file.target !== '' && !file.target.includes('\0')
  return kind === 'file' ? isHash(file.hash) : file.hash === ''
}

/** Where a link at `rel` points, as a workspace path, or null when it points outside the workspace. */
export function linkTarget(rel: string, target: string): string | null {
  let rest = target
  if (rest === '/workspace' || rest.startsWith('/workspace/')) rest = rest.slice('/workspace/'.length)
  else if (rest.startsWith('/')) return null
  const parts = target.startsWith('/') ? [] : rel.split('/').slice(0, -1)
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

function fileEntry(row: { path: string; size: number; mtime: number }): StoredEntry {
  return {
    name: row.path.slice(row.path.lastIndexOf('/') + 1),
    path: row.path,
    type: 'file',
    size: row.size,
    ...(row.mtime ? { modifiedAt: new Date(row.mtime).toISOString() } : {}),
  }
}
