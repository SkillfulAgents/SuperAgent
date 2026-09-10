/**
 * Workspace file operations for an agent whose workspace is a directory on
 * this machine.
 *
 * Containment is enforced here, twice: lexically (`isPathWithinDir` on the
 * resolved path) and for real (the path's existing prefix is resolved through
 * symlinks and checked against the real root). Links are not followed out of
 * the workspace: an entry whose real location is outside reads as an escape,
 * a dangling link reads as absent, and writes never go through a link.
 */
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
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
    case 'ENOENT':
    case 'ENOTDIR':
      throw new WorkspaceFileError('not-found')
    case 'EISDIR':
      throw new WorkspaceFileError('not-a-file')
    case 'EACCES':
    case 'EPERM':
      throw new WorkspaceFileError('not-accessible')
    default:
      throw error
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    return fromFsError(error)
  }
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    return fromFsError(error)
  }
}

interface Located {
  /** The normalized workspace path. */
  rel: string
  /** The lexical absolute path (may be a link). */
  abs: string
  /** The real absolute path, inside the real root. */
  real: string
  /** Whether resolving the path went through a link (that stayed inside the root). */
  throughLink: boolean
}

export class LocalFileOps implements FileOps {
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

  /**
   * An existing path's real location, or null when nothing is there (a
   * dangling link counts as nothing). Throws `outside-workspace` when the
   * real location has left the real root.
   */
  private async existing(workspacePath: string): Promise<Located | null> {
    const { rel, abs, root } = this.absolute(workspacePath)
    const realRoot = await realpathOrNull(root)
    if (!realRoot) return null
    const real = await realpathOrNull(abs)
    if (!real) return null
    if (!isPathWithinDir(realRoot, real)) throw new WorkspaceFileError('outside-workspace')
    const direct = rel === '' ? realRoot : path.join(realRoot, ...rel.split('/'))
    return { rel, abs, real, throughLink: real !== direct }
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
    await fs.promises.mkdir(root, { recursive: true })
    const realRoot = await fs.promises.realpath(root)

    const targetStat = await lstatOrNull(abs)
    if (targetStat?.isSymbolicLink()) {
      throw new WorkspaceFileError('outside-workspace', 'Refusing to write through a link')
    }

    let existing = path.dirname(abs)
    const tail = [path.basename(abs)]
    while (!(await lstatOrNull(existing))) {
      tail.unshift(path.basename(existing))
      const parent = path.dirname(existing)
      if (parent === existing) throw new WorkspaceFileError('outside-workspace')
      existing = parent
    }
    const realExisting = await fs.promises.realpath(existing).catch(fromFsError)
    const realTarget = path.join(realExisting, ...tail)
    if (!isPathWithinDir(realRoot, realTarget)) throw new WorkspaceFileError('outside-workspace')

    try {
      await fs.promises.mkdir(path.dirname(realTarget), { recursive: true })
    } catch (error) {
      // A file where a parent directory should be.
      if (errnoCode(error) === 'EEXIST' || errnoCode(error) === 'ENOTDIR') {
        throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
      }
      return fromFsError(error)
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
        ? { kind: 'directory', size: 0, mtimeMs: 0, throughLink: false }
        : null
    }
    const stat = await fs.promises.stat(found.real).catch(fromFsError)
    const { throughLink } = found
    if (stat.isDirectory()) return { kind: 'directory', size: stat.size, mtimeMs: stat.mtimeMs, throughLink }
    if (stat.isFile()) return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, throughLink }
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
      const code = errnoCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      return fromFsError(error)
    }
  }

  async putDoc(workspacePath: string, bytes: Uint8Array | string): Promise<void> {
    const { abs } = await this.forWrite(workspacePath)
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes)
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.promises.writeFile(tmp, data)
      await fs.promises.rename(tmp, abs)
    } catch (error) {
      await fs.promises.unlink(tmp).catch(() => {})
      return fromFsError(error)
    }
  }

  async write(workspacePath: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ size: number }> {
    const { abs } = await this.forWrite(workspacePath)
    const source =
      body instanceof Uint8Array
        ? Readable.from([Buffer.from(body)])
        : Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>)
    try {
      await pipeline(source, fs.createWriteStream(abs))
    } catch (error) {
      // Don't leave a partial file behind (pipeline already closed the fd).
      await fs.promises.unlink(abs).catch(() => {})
      return fromFsError(error)
    }
    const stat = await fs.promises.stat(abs).catch(fromFsError)
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
