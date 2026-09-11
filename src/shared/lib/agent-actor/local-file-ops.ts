/**
 * Workspace file operations for an agent whose workspace is a directory on
 * this machine.
 *
 * Containment is enforced here, twice: lexically (`isPathWithinDir` on the
 * resolved path) and for real (the path's existing prefix is resolved through
 * symlinks and checked against the real root). Links are not followed out of
 * the workspace: an entry whose real location is outside reads as an escape,
 * a dangling or looping link reads as absent, and writes never go through a
 * link.
 *
 * The root's real location is resolved once per root path and kept: it is the
 * same string for the life of the workspace, and resolving it on every call
 * doubled the filesystem operations of every read on the agents-list path. A
 * path that looks like an escape re-resolves the root once before it is
 * called one, so a root replaced underneath the cache heals itself.
 *
 * Writes go through the same temp-file, fsync, rename core as every other
 * atomic write in the app: a crash never leaves a torn or empty file, a
 * reader (the container included) never sees a half-written one, and an
 * existing file keeps its mode and owner unless a mode is asked for. A
 * document (`putDoc`) is flushed to disk before the write returns; bulk
 * content (`write`: uploads, imports) is renamed into place whole but not
 * flushed, as it never was, because a flush per file is what makes a
 * thousand-file import slow.
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { writeFileAtomicStream } from '@shared/lib/utils/file-storage'
import type { ByteRange, FileEntry, FileOps, FileStat, WriteOptions } from './types'
import { WorkspaceFileError, normalizeWorkspacePath, workspaceDirname } from './workspace-path'

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

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch (error) {
    if (isAbsence(error)) return null
    return fromFsError(error)
  }
}

/**
 * A mode the caller asks for is applied whatever the file had before: the
 * rename transfers ownership to this process, and a preserved restrictive
 * mode would leave a file another uid (the container) can no longer read.
 * With no mode asked for, an existing file keeps its mode and owner.
 */
function atomicWriteOptions(options?: WriteOptions): { mode: number; forceMode: true } | undefined {
  return options?.mode === undefined ? undefined : { mode: options.mode, forceMode: true }
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

interface Located {
  /** The normalized workspace path. */
  rel: string
  /** The lexical absolute path (may be a link). */
  abs: string
  /** The real absolute path, inside the real root. */
  real: string
  /** The workspace path of `real`: `rel` unless a link on the way was followed. */
  resolved: string
}

export class LocalFileOps implements FileOps {
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

  /** The root's real location, resolved once per root path; null while the root does not exist. */
  private async realRoot(root: string, refresh = false): Promise<string | null> {
    if (!refresh && this.realRootCache?.root === root) return this.realRootCache.real
    const real = await realpathOrNull(root)
    this.realRootCache = real ? { root, real } : null
    return real
  }

  /**
   * The real root that contains `real`. A miss re-resolves the root once, so
   * a root replaced underneath the cache is not mistaken for an escape; a
   * miss against the fresh root is one.
   */
  private async containingRoot(root: string, realRoot: string, real: string): Promise<string> {
    if (isPathWithinDir(realRoot, real)) return realRoot
    const fresh = await this.realRoot(root, true)
    if (fresh && isPathWithinDir(fresh, real)) return fresh
    throw new WorkspaceFileError('outside-workspace')
  }

  /**
   * An existing path's real location, or null when nothing is there (a
   * dangling or looping link counts as nothing). Throws `outside-workspace`
   * when the real location has left the real root.
   */
  private async existing(workspacePath: string): Promise<Located | null> {
    const { rel, abs, root } = this.absolute(workspacePath)
    const cachedRoot = await this.realRoot(root)
    if (!cachedRoot) return null
    const real = await realpathOrNull(abs)
    if (!real) return null
    const realRoot = await this.containingRoot(root, cachedRoot, real)
    return { rel, abs, real, resolved: toWorkspacePath(path.relative(realRoot, real)) }
  }

  /**
   * Where to write `workspacePath`: the root and the missing parents are
   * created, the deepest existing ancestor is resolved through links and
   * checked against the real root, and a link at the target itself is refused
   * so a write can never land outside the workspace.
   */
  private async forWrite(workspacePath: string): Promise<{ rel: string; abs: string }> {
    const { rel, abs, root } = this.absolute(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root is not a file')
    let realRoot = await this.realRoot(root)
    if (!realRoot) {
      await fs.promises.mkdir(root, { recursive: true }).catch(fromFsError)
      realRoot = await fs.promises.realpath(root).catch(fromFsError)
      this.realRootCache = { root, real: realRoot }
    }

    const targetStat = await lstatOrNull(abs)
    if (targetStat?.isSymbolicLink()) {
      throw new WorkspaceFileError('outside-workspace', 'Refusing to write through a link')
    }

    // The common case, the parent in place, is one call: resolve it. Only a
    // missing parent walks up to the deepest existing ancestor, and only then
    // is anything created. A file where the parent should be resolves too;
    // the write that follows fails on it and reports `not-a-directory`.
    let existing = path.dirname(abs)
    const tail = [path.basename(abs)]
    let realExisting = await realpathOrNull(existing)
    while (realExisting === null) {
      tail.unshift(path.basename(existing))
      const parent = path.dirname(existing)
      if (parent === existing) throw new WorkspaceFileError('outside-workspace')
      existing = parent
      realExisting = await realpathOrNull(existing)
    }
    const realTarget = path.join(realExisting, ...tail)
    await this.containingRoot(root, realRoot, realTarget)

    if (tail.length > 1) {
      try {
        await fs.promises.mkdir(path.dirname(realTarget), { recursive: true })
      } catch (error) {
        // A file where a parent directory should be.
        if (errnoCode(error) === 'EEXIST' || errnoCode(error) === 'ENOTDIR') {
          throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
        }
        return fromFsError(error)
      }
    }
    return { rel, abs: realTarget }
  }

  /**
   * Copy a file from this machine into the workspace in one filesystem copy,
   * keeping its mode. Not part of `FileOps`: the source is a host path, which
   * only a workspace on this machine can reach directly. A bulk import (a
   * folder upload, a skillset install) uses it instead of streaming each
   * file through `write`, which costs several operations per file. The copy
   * itself is not atomic, like the plain copy it replaces; the containment
   * check on the destination is the same one every write gets.
   */
  async copyHostFile(hostPath: string, workspacePath: string): Promise<void> {
    const { abs } = await this.forWrite(workspacePath)
    await fs.promises.copyFile(hostPath, abs).catch(fromWriteError)
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
    const { abs } = await this.forWrite(workspacePath)
    try {
      await fs.promises.rename(hostPath, abs)
    } catch (error) {
      if (errnoCode(error) !== 'EXDEV') fromWriteError(error)
      await fs.promises.copyFile(hostPath, abs).catch(fromWriteError)
      await fs.promises.unlink(hostPath)
    }
    const stat = await fs.promises.stat(abs).catch(fromFsError)
    return { size: stat.size }
  }

  async list(dir: string): Promise<FileEntry[]> {
    const found = await this.existing(dir)
    if (!found) {
      // The root exists by definition; it is empty until the first write.
      if (normalizeWorkspacePath(dir) === '') return []
      throw new WorkspaceFileError('not-found')
    }
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(found.real, { withFileTypes: true })
    } catch (error) {
      if (errnoCode(error) === 'ENOTDIR') throw new WorkspaceFileError('not-a-directory')
      return fromFsError(error)
    }
    return dirents
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .map((entry) => ({
        name: entry.name,
        path: found.rel === '' ? entry.name : `${found.rel}/${entry.name}`,
        kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
  }

  async stat(workspacePath: string): Promise<FileStat | null> {
    const found = await this.existing(workspacePath)
    if (!found) {
      return normalizeWorkspacePath(workspacePath) === ''
        ? { kind: 'directory', size: 0, mtimeMs: 0, resolvedPath: '' }
        : null
    }
    const stat = await fs.promises.stat(found.real).catch(fromFsError)
    const resolvedPath = found.resolved
    const mode = modeBits(stat)
    if (stat.isDirectory()) return { kind: 'directory', size: stat.size, mtimeMs: stat.mtimeMs, resolvedPath, mode }
    if (stat.isFile()) return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, resolvedPath, mode }
    return null
  }

  async read(workspacePath: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const found = await this.existing(workspacePath)
    if (!found) throw new WorkspaceFileError('not-found')
    const stat = await fs.promises.stat(found.real).catch(fromFsError)
    if (!stat.isFile()) throw new WorkspaceFileError('not-a-file')
    if (range && (range.start < 0 || range.end < range.start || range.end >= stat.size)) {
      throw new WorkspaceFileError('invalid-path', 'Byte range out of bounds')
    }
    const source = fs.createReadStream(found.real, range ? { start: range.start, end: range.end } : undefined)
    return Readable.toWeb(source) as ReadableStream<Uint8Array>
  }

  async getDoc(workspacePath: string): Promise<Uint8Array | null> {
    const found = await this.existing(workspacePath)
    if (!found) return null
    try {
      // The Buffer itself: a copy into a plain Uint8Array would double the
      // memory of every document read.
      return await fs.promises.readFile(found.real)
    } catch (error) {
      if (isAbsence(error)) return null
      return fromFsError(error)
    }
  }

  async putDoc(workspacePath: string, bytes: Uint8Array | string, options?: WriteOptions): Promise<void> {
    const { abs } = await this.forWrite(workspacePath)
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : asBuffer(bytes)
    await writeFileAtomicStream(abs, [data], atomicWriteOptions(options)).catch(fromWriteError)
  }

  async write(
    workspacePath: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: WriteOptions,
  ): Promise<{ size: number }> {
    let target: { rel: string; abs: string }
    try {
      target = await this.forWrite(workspacePath)
    } catch (error) {
      // The caller may already hold the source open; a refused destination
      // must not leave it dangling.
      if (!(body instanceof Uint8Array)) await body.cancel().catch(() => {})
      throw error
    }
    const source = body instanceof Uint8Array
      ? null
      : Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>)
    try {
      await writeFileAtomicStream(target.abs, source ?? [asBuffer(body as Uint8Array)], {
        ...atomicWriteOptions(options),
        fsync: false,
      })
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
    // The parent is contained for real before the leaf is touched. A link at
    // the leaf is removed as a link, never followed, but only when the
    // directory holding it really is inside the workspace: reached through a
    // link that leaves the workspace, the leaf is someone else's entry.
    const parent = await this.existing(workspaceDirname(rel))
    if (!parent) return
    const leaf = path.join(parent.real, path.basename(abs))
    const stat = await lstatOrNull(leaf)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      await fs.promises.unlink(leaf).catch(fromFsError)
      return
    }
    if (stat.isDirectory()) {
      if (!options?.recursive) {
        throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
      }
      await fs.promises.rm(leaf, { recursive: true, force: true }).catch(fromFsError)
      return
    }
    await fs.promises.rm(leaf, { force: true }).catch(fromFsError)
  }

  async mkdir(workspacePath: string): Promise<void> {
    const { rel, root } = this.absolute(workspacePath)
    if (rel === '') {
      await fs.promises.mkdir(root, { recursive: true }).catch(fromFsError)
      return
    }
    const { abs } = await this.forWrite(workspacePath)
    try {
      await fs.promises.mkdir(abs, { recursive: true })
    } catch (error) {
      if (errnoCode(error) === 'EEXIST' || errnoCode(error) === 'ENOTDIR') {
        throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
      }
      return fromFsError(error)
    }
  }
}
