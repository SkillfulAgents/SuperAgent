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
 * existing file keeps its mode and owner.
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

/** A host-relative path in workspace spelling: posix separators, `''` for the root. */
function toWorkspacePath(relative: string): string {
  return relative.split(path.sep).join('/')
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

  workspacePath(): string {
    return this.rootDir()
  }

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
    if (stat.isDirectory()) return { kind: 'directory', size: stat.size, mtimeMs: stat.mtimeMs, resolvedPath }
    if (stat.isFile()) return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, resolvedPath }
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
      return new Uint8Array(await fs.promises.readFile(found.real))
    } catch (error) {
      if (isAbsence(error)) return null
      return fromFsError(error)
    }
  }

  async putDoc(workspacePath: string, bytes: Uint8Array | string): Promise<void> {
    const { abs } = await this.forWrite(workspacePath)
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes)
    await writeFileAtomicStream(abs, [data]).catch(fromWriteError)
  }

  async write(workspacePath: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ size: number }> {
    let target: { rel: string; abs: string }
    try {
      target = await this.forWrite(workspacePath)
    } catch (error) {
      // The caller may already hold the source open; a refused destination
      // must not leave it dangling.
      if (!(body instanceof Uint8Array)) await body.cancel().catch(() => {})
      throw error
    }
    const chunks = body instanceof Uint8Array
      ? [Buffer.from(body)]
      : Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>)
    await writeFileAtomicStream(target.abs, chunks).catch(fromWriteError)
    const stat = await fs.promises.stat(target.abs).catch(fromFsError)
    return { size: stat.size }
  }

  async delete(workspacePath: string, options?: { recursive?: boolean }): Promise<void> {
    const { rel, abs } = this.absolute(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root cannot be deleted')
    const stat = await lstatOrNull(abs)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      // Remove the link itself, never what it points at.
      await fs.promises.unlink(abs).catch(fromFsError)
      return
    }
    // The link check above covers the leaf; a linked ancestor is an escape.
    const found = await this.existing(workspacePath)
    if (!found) return
    if (stat.isDirectory()) {
      if (!options?.recursive) {
        throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
      }
      await fs.promises.rm(found.real, { recursive: true, force: true }).catch(fromFsError)
      return
    }
    await fs.promises.rm(found.real, { force: true }).catch(fromFsError)
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
