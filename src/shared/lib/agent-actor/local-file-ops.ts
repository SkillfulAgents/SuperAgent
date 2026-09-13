/**
 * Workspace file operations for an agent whose workspace is a directory on
 * this machine.
 *
 * Containment is lexical, as it was for the plain filesystem calls these
 * operations replace: a workspace path is resolved against the root and
 * refused when it leaves it (`..`, an absolute path). Links are followed the
 * way the filesystem follows them. `resolve` answers where a path really
 * leads, for the callers that served a file by its real location or scoped a
 * shared sub-tree by it before; checking every operation by real location is
 * tracked separately.
 *
 * Writes go through the same temp-file, fsync, rename core as every other
 * atomic write in the app: a crash never leaves a torn or empty file, a
 * reader (the container included) never sees a half-written one, and an
 * existing file keeps its mode and owner. A document (`putDoc`) is flushed to
 * disk before the write returns; bulk content (`write`: uploads, imports) is
 * renamed into place whole but not flushed, as it never was, because a flush
 * per file is what makes a thousand-file import slow.
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { writeFileAtomicStream } from '@shared/lib/utils/file-storage'
import type { ByteRange, FileEntry, FileOps, FileStat } from './types'
import { WorkspaceFileError, normalizeWorkspacePath } from './workspace-path'

export interface LocalFileOpsDeps {
  getAgentWorkspaceDir: (slug: string) => string
}

export function createLocalFileOps(slug: string, deps: LocalFileOpsDeps): FileOps {
  // Read at call time: tests and embedded deployments change the data dir in-process.
  return new LocalFileOps(() => deps.getAgentWorkspaceDir(slug))
}

type ErrnoLike = { code?: string }

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as ErrnoLike).code : undefined
}

/** Translate a filesystem error into the contract's error, or rethrow it. */
function fromFsError(error: unknown): never {
  switch (errnoCode(error)) {
    // A link that loops (ELOOP) resolves to nothing trustworthy: the same as nothing there.
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ELOOP':
      throw new WorkspaceFileError('not-found')
    case 'EISDIR':
      throw new WorkspaceFileError('not-a-file')
    case 'ENAMETOOLONG':
      throw new WorkspaceFileError('invalid-path')
    case 'EACCES':
    case 'EPERM':
      throw new WorkspaceFileError('not-accessible')
    default:
      throw error
  }
}

/** A write's filesystem error: a file where a parent directory should be is `not-a-directory`; the rest as for reads. */
function fromWriteError(error: unknown): never {
  if (errnoCode(error) === 'ENOTDIR') throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
  return fromFsError(error)
}

/**
 * Copy a file onto `to`, replacing whatever is there rather than writing
 * through it. A plain copy follows a link at the destination, and the agent
 * can plant one in the workspace from inside the container, so the copy
 * would land on the file the link points at. The exclusive create refuses
 * any existing entry, link or file; that entry is removed and the create
 * tried once more, so a link planted in between is refused, not followed.
 * In the common case, a fresh destination, this is the one copy it was.
 */
async function copyFileReplacing(from: string, to: string): Promise<void> {
  const exclusive = fs.constants.COPYFILE_EXCL
  try {
    await fs.promises.copyFile(from, to, exclusive)
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error
    await fs.promises.unlink(to)
    await fs.promises.copyFile(from, to, exclusive)
  }
}

/** True for the errors that mean "nothing is there": absent, a file in a directory's place, a link loop. */
function isAbsence(error: unknown): boolean {
  const code = errnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP'
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p)
  } catch (error) {
    if (isAbsence(error)) return null
    return fromFsError(error)
  }
}

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p)
  } catch (error) {
    if (isAbsence(error)) return null
    return fromFsError(error)
  }
}

/** A host-relative path in workspace spelling: posix separators, `''` for the root. */
function toWorkspacePath(relative: string): string {
  return relative.split(path.sep).join('/')
}

/** The same bytes as a Buffer, without copying them. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** The permission bits of a stat, the part a caller may keep or carry. */
function modeBits(stat: fs.Stats): number {
  return stat.mode & 0o777
}

/** Create the directories a path is written under. A file in the way is `not-a-directory`. */
async function ensureDirectory(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true })
  } catch (error) {
    if (errnoCode(error) === 'EEXIST' || errnoCode(error) === 'ENOTDIR') {
      throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
    }
    return fromFsError(error)
  }
}

export class LocalFileOps implements FileOps {
  /** The root's real location, kept for `resolve`: the same string for the life of the workspace. */
  private realRootCache: { root: string; real: string } | null = null

  constructor(private readonly rootDir: () => string) {}

  /** Resolve a workspace path lexically and check it stays under the root. */
  private absolute(workspacePath: string): { rel: string; abs: string; root: string } {
    const rel = normalizeWorkspacePath(workspacePath)
    const root = path.resolve(this.rootDir())
    const abs = rel === '' ? root : path.resolve(root, ...rel.split('/'))
    if (!isPathWithinDir(root, abs)) throw new WorkspaceFileError('outside-workspace')
    return { rel, abs, root }
  }

  /** A path to write at: any workspace path but the root. */
  private forWrite(workspacePath: string): { rel: string; abs: string } {
    const { rel, abs } = this.absolute(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root is not a file')
    return { rel, abs }
  }

  /**
   * Run a write, creating the target's parent directories only when the
   * write finds them missing: the common case, the parent in place, costs
   * the write alone, as the plain writes did. The attempt must not have
   * consumed its source when it fails to open the target, which the atomic
   * writer and a rename guarantee.
   */
  private async writing<T>(abs: string, attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt()
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
      await ensureDirectory(path.dirname(abs))
      return attempt()
    }
  }

  /** The root's real location, resolved once per root path; null while the root does not exist. */
  private async realRoot(root: string, refresh = false): Promise<string | null> {
    if (!refresh && this.realRootCache?.root === root) return this.realRootCache.real
    const real = await realpathOrNull(root)
    this.realRootCache = real ? { root, real } : null
    return real
  }

  async resolve(workspacePath: string): Promise<string | null> {
    const { abs, root } = this.absolute(workspacePath)
    const cachedRoot = await this.realRoot(root)
    if (!cachedRoot) return null
    const real = await realpathOrNull(abs)
    if (!real) return null
    // A miss re-resolves the root once, so a root replaced underneath the
    // cache is not mistaken for an escape; a miss against the fresh root is one.
    let realRoot = cachedRoot
    if (!isPathWithinDir(realRoot, real)) {
      const fresh = await this.realRoot(root, true)
      if (!fresh || !isPathWithinDir(fresh, real)) throw new WorkspaceFileError('outside-workspace')
      realRoot = fresh
    }
    return toWorkspacePath(path.relative(realRoot, real))
  }

  /**
   * Copy a file from this machine into the workspace in one filesystem copy,
   * keeping its mode. Not part of `FileOps`: the source is a host path, which
   * only a workspace on this machine can reach directly. A bulk import (a
   * folder upload, a skillset install) uses it instead of streaming each
   * file through `write`; the caller creates the directories, as the plain
   * copy it replaces did once per directory rather than once per file.
   */
  async copyHostFile(hostPath: string, workspacePath: string): Promise<void> {
    const { rel, abs } = this.absolute(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root is not a file')
    await copyFileReplacing(hostPath, abs).catch(fromWriteError)
  }

  /**
   * Move a file from this machine into the workspace: one rename when the
   * two are on the same filesystem, a copy and a delete otherwise. Not part
   * of `FileOps` for the same reason as `copyHostFile`. An assembled chunked
   * upload arrives this way: the temp dir usually shares the data dir's
   * filesystem, so a file that was already written in full is not written a
   * second time.
   */
  async moveHostFile(hostPath: string, workspacePath: string): Promise<{ size: number }> {
    const { abs } = this.forWrite(workspacePath)
    try {
      await this.writing(abs, () => fs.promises.rename(hostPath, abs))
    } catch (error) {
      if (errnoCode(error) !== 'EXDEV') fromWriteError(error)
      await copyFileReplacing(hostPath, abs).catch(fromWriteError)
      await fs.promises.unlink(hostPath)
    }
    const stat = await fs.promises.stat(abs).catch(fromFsError)
    return { size: stat.size }
  }

  async list(dir: string): Promise<FileEntry[]> {
    const { rel, abs } = this.absolute(dir)
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch (error) {
      // The root exists by definition; it is empty until the first write.
      if (rel === '' && isAbsence(error)) return []
      if (errnoCode(error) === 'ENOTDIR') throw new WorkspaceFileError('not-a-directory')
      return fromFsError(error)
    }
    return dirents
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .map((entry) => ({
        name: entry.name,
        path: rel === '' ? entry.name : `${rel}/${entry.name}`,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
  }

  async stat(workspacePath: string): Promise<FileStat | null> {
    const { rel, abs } = this.absolute(workspacePath)
    const stat = await statOrNull(abs)
    if (!stat) return rel === '' ? { kind: 'directory', size: 0, mtimeMs: 0 } : null
    const mode = modeBits(stat)
    if (stat.isDirectory()) return { kind: 'directory', size: stat.size, mtimeMs: stat.mtimeMs, mode }
    if (stat.isFile()) return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, mode }
    return null
  }

  async read(workspacePath: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const { abs } = this.absolute(workspacePath)
    const stat = await fs.promises.stat(abs).catch(fromFsError)
    if (!stat.isFile()) throw new WorkspaceFileError('not-a-file')
    if (range && (range.start < 0 || range.end < range.start || range.end >= stat.size)) {
      throw new WorkspaceFileError('invalid-path', 'Byte range out of bounds')
    }
    const source = fs.createReadStream(abs, range ? { start: range.start, end: range.end } : undefined)
    return Readable.toWeb(source) as ReadableStream<Uint8Array>
  }

  async getDoc(workspacePath: string): Promise<Uint8Array | null> {
    const { abs } = this.absolute(workspacePath)
    try {
      // The Buffer itself: a copy into a plain Uint8Array would double the
      // memory of every document read.
      return await fs.promises.readFile(abs)
    } catch (error) {
      if (isAbsence(error)) return null
      return fromFsError(error)
    }
  }

  async putDoc(workspacePath: string, bytes: Uint8Array | string): Promise<void> {
    const { abs } = this.forWrite(workspacePath)
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : asBuffer(bytes)
    await this.writing(abs, () => writeFileAtomicStream(abs, [data])).catch(fromWriteError)
  }

  async write(workspacePath: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ size: number }> {
    let target: { rel: string; abs: string }
    try {
      target = this.forWrite(workspacePath)
    } catch (error) {
      // The caller may already hold the source open; a refused destination
      // must not leave it dangling.
      if (!(body instanceof Uint8Array)) await body.cancel().catch(() => {})
      throw error
    }
    const source = body instanceof Uint8Array
      ? null
      : Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>)
    // The source can fail before the writer reads it: a zip entry that
    // inflates past its declared size is failed by the reader at once, while
    // the writer is still opening its temp file. A stream failing with no
    // listener is fatal to the process; with one, the failure reaches the
    // writer's iteration and rejects the write like any other.
    source?.on('error', () => {})
    const chunks = source ?? [asBuffer(body as Uint8Array)]
    try {
      await this.writing(target.abs, () => writeFileAtomicStream(target.abs, chunks, { fsync: false }))
    } catch (error) {
      // A destination that could not be opened (or written) leaves the
      // source unread; end it, or the file behind it stays open.
      source?.destroy()
      fromWriteError(error)
    }
    const stat = await fs.promises.stat(target.abs).catch(fromFsError)
    return { size: stat.size }
  }

  async delete(workspacePath: string, options?: { recursive?: boolean }): Promise<void> {
    const { rel, abs } = this.absolute(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root cannot be deleted')
    // lstat, not stat: a link is removed as a link, never followed.
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(abs)
    } catch (error) {
      if (isAbsence(error)) return
      return fromFsError(error)
    }
    if (stat.isDirectory() && !options?.recursive) {
      throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
    }
    await fs.promises.rm(abs, { recursive: stat.isDirectory(), force: true }).catch(fromFsError)
  }

  async mkdir(workspacePath: string): Promise<void> {
    const { abs } = this.absolute(workspacePath)
    await ensureDirectory(abs)
  }
}
