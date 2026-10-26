/**
 * The agent's workspace as the host reaches it over HTTP: one route per
 * `FileOps` operation, so a host whose workspace is inside the container (a
 * remote sandbox) reads and writes it with the same contract as a workspace
 * on its own disk.
 *
 * Keep in sync with src/shared/lib/agent-actor/local-file-ops.ts: the same
 * semantics, error codes and containment. The FileOps contract suite runs
 * against these routes (src/shared/lib/agent-actor/container-file-ops.test.ts),
 * so a difference fails there.
 *
 * Every path is a workspace path in the `path` query parameter: relative to the
 * workspace root, posix, `/workspace/…` accepted. A path that would leave the
 * workspace lexically is refused before anything is touched. With `confined`,
 * a path that leads out of the workspace through a link is refused too.
 */
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import type { Context, Hono } from 'hono'

export const WORKSPACE_FS_PREFIX = '/workspace/fs'

/** Header carrying a file's size at the moment it was opened for a read. */
export const WORKSPACE_FILE_SIZE_HEADER = 'X-Workspace-File-Size'

type ErrorCode =
  | 'already-exists'
  | 'invalid-path'
  | 'outside-workspace'
  | 'not-found'
  | 'not-a-file'
  | 'not-a-directory'
  | 'not-accessible'
  | 'not-empty'

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409> = {
  'already-exists': 409,
  'invalid-path': 400,
  'outside-workspace': 400,
  'not-found': 404,
  'not-a-file': 404,
  'not-a-directory': 404,
  'not-accessible': 403,
  'not-empty': 409,
}

class WorkspaceFsError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) {
    super(message)
    this.name = 'WorkspaceFsError'
  }
}

const errnoCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined

function fromFsError(error: unknown): never {
  if (error instanceof WorkspaceFsError) throw error
  switch (errnoCode(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ELOOP':
      throw new WorkspaceFsError('not-found')
    case 'EEXIST':
      throw new WorkspaceFsError('already-exists')
    case 'ENOTEMPTY':
      throw new WorkspaceFsError('not-empty')
    case 'EISDIR':
      throw new WorkspaceFsError('not-a-file')
    case 'ENAMETOOLONG':
      throw new WorkspaceFsError('invalid-path')
    case 'EACCES':
    case 'EPERM':
      throw new WorkspaceFsError('not-accessible')
    default:
      throw error
  }
}

function fromWriteError(error: unknown): never {
  if (errnoCode(error) === 'ENOTDIR') throw new WorkspaceFsError('not-a-directory', 'A file is in the way')
  return fromFsError(error)
}

const isAbsence = (error: unknown): boolean => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errnoCode(error) ?? '')

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Same rules as `normalizeWorkspacePath` in src/shared/lib/agent-actor/workspace-path.ts. */
function normalize(input: string): string {
  if (typeof input !== 'string' || input.includes('\0')) throw new WorkspaceFsError('invalid-path')
  let p = input.replace(/\\/g, '/')
  if (p === '/workspace' || p.startsWith('/workspace/')) p = p.slice('/workspace'.length).replace(/^\/+/, '')
  if (p.startsWith('/')) throw new WorkspaceFsError('invalid-path')
  const normalized = path.posix.normalize(p === '' ? '.' : p)
  const trimmed = normalized === '.' ? '' : normalized.replace(/^\.\//, '').replace(/\/+$/, '')
  if (trimmed === '..' || trimmed.startsWith('../')) throw new WorkspaceFsError('invalid-path')
  return trimmed
}

async function ensureDirectory(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true })
  } catch (error) {
    if (errnoCode(error) === 'EEXIST' || errnoCode(error) === 'ENOTDIR') {
      throw new WorkspaceFsError('not-a-directory', 'A file is in the way')
    }
    fromFsError(error)
  }
}

/** Appends in flight by file: a large buffer is written in several calls, so two appends must not overlap. */
const appendsInFlight = new Map<string, Promise<void>>()

async function appendSerialized(abs: string, write: () => Promise<void>): Promise<void> {
  const previous = appendsInFlight.get(abs) ?? Promise.resolve()
  const run = previous.then(write, write)
  appendsInFlight.set(abs, run)
  try {
    await run
  } finally {
    if (appendsInFlight.get(abs) === run) appendsInFlight.delete(abs)
  }
}

export interface WorkspaceFileStat {
  kind: 'file' | 'directory'
  size: number
  mtimeMs: number
  mode: number
  birthtimeMs: number
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export interface WorkspaceWriteOptions {
  mode?: number
  flush?: boolean
  overwrite?: boolean
  confined?: boolean
}

/** The workspace operations over one root directory. */
export class WorkspaceFs {
  constructor(private readonly root: string) {}

  private absolute(input: string): { rel: string; abs: string } {
    const rel = normalize(input)
    const root = path.resolve(this.root)
    const abs = rel === '' ? root : path.resolve(root, ...rel.split('/'))
    if (!isWithin(root, abs)) throw new WorkspaceFsError('outside-workspace')
    return { rel, abs }
  }

  private forWrite(input: string): { rel: string; abs: string } {
    const target = this.absolute(input)
    if (target.rel === '') throw new WorkspaceFsError('invalid-path', 'The workspace root is not a file')
    return target
  }

  /**
   * The canonical location of `abs`, refused when a link leads it out of the
   * workspace. The root itself is refused unless `allowRoot` (a directory a
   * file is written into).
   */
  private async confinedLocation(abs: string, allowRoot = false): Promise<string> {
    const canonicalRoot = await fs.promises.realpath(this.root).catch(fromFsError)
    const canonical = await fs.promises.realpath(abs).catch(fromFsError)
    if (!isWithin(canonicalRoot, canonical) || (!allowRoot && canonical === canonicalRoot)) {
      throw new WorkspaceFsError('outside-workspace')
    }
    return canonical
  }

  /** Create the parent directories only when the write finds them missing. */
  private async writing<T>(abs: string, attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt()
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error
      await ensureDirectory(path.dirname(abs))
      return attempt()
    }
  }

  async stat(input: string): Promise<WorkspaceFileStat | null> {
    const { rel, abs } = this.absolute(input)
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(abs)
    } catch (error) {
      if (!isAbsence(error)) fromFsError(error)
      return rel === '' ? { kind: 'directory', size: 0, mtimeMs: 0, mode: 0o755, birthtimeMs: 0 } : null
    }
    if (!stat.isDirectory() && !stat.isFile()) return null
    return {
      kind: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode & 0o777,
      birthtimeMs: stat.birthtimeMs,
    }
  }

  async list(input: string): Promise<WorkspaceFileEntry[]> {
    const { rel, abs } = this.absolute(input)
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch (error) {
      if (rel === '' && isAbsence(error)) return []
      if (errnoCode(error) === 'ENOTDIR') throw new WorkspaceFsError('not-a-directory')
      return fromFsError(error)
    }
    return dirents
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .map((entry) => ({
        name: entry.name,
        path: rel === '' ? entry.name : `${rel}/${entry.name}`,
        kind: entry.isDirectory() ? 'directory' : 'file',
      }))
  }

  async resolve(input: string): Promise<string | null> {
    const { abs } = this.absolute(input)
    const root = path.resolve(this.root)
    const realRoot = await fs.promises.realpath(root).catch((error) => (isAbsence(error) ? null : fromFsError(error)))
    if (!realRoot) return null
    // An absent path still leads somewhere: through its nearest existing ancestor.
    let existing = abs
    let real = await fs.promises.realpath(existing).catch((error) => (isAbsence(error) ? null : fromFsError(error)))
    while (!real) {
      const parent = path.dirname(existing)
      if (parent === existing || !isWithin(root, parent)) return null
      existing = parent
      real = await fs.promises.realpath(existing).catch((error) => (isAbsence(error) ? null : fromFsError(error)))
    }
    if (!isWithin(realRoot, real)) throw new WorkspaceFsError('outside-workspace')
    if (existing !== abs) return null
    return path.relative(realRoot, real).split(path.sep).join('/')
  }

  /**
   * A file's bytes from one open: its size at the open, and a stream bounded
   * to that size or to `range`. A strict range must lie inside the file; a
   * lenient one is cut at the end of the file (reads at an offset).
   */
  async read(
    input: string,
    options: { start?: number; end?: number; lenient?: boolean; confined?: boolean } = {},
  ): Promise<{ size: number; stream: Readable }> {
    const { rel, abs } = this.absolute(input)
    if (rel === '') throw new WorkspaceFsError('not-a-file')
    const location = options.confined ? await this.confinedLocation(abs) : abs
    const flags = options.confined ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 'r'
    const handle = await fs.promises.open(location, flags).catch(fromFsError)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new WorkspaceFsError('not-a-file')
      const size = stat.size
      let start = options.start ?? 0
      let end = options.end ?? size - 1
      if (options.start !== undefined || options.end !== undefined) {
        if (options.lenient) {
          end = Math.min(end, size - 1)
        } else if (start < 0 || end < start || end >= size) {
          throw new WorkspaceFsError('invalid-path', 'Byte range out of bounds')
        }
      }
      if (start < 0) start = 0
      if (size === 0 || start > end) {
        await handle.close()
        return { size, stream: Readable.from([]) }
      }
      return { size, stream: handle.createReadStream({ start, end }) }
    } catch (error) {
      await handle.close().catch(() => {})
      return fromFsError(error)
    }
  }

  /**
   * Write a whole file from a stream: staged beside the destination, then
   * renamed into place, so no reader sees half of it. A mode asked for is
   * applied; without one an existing file keeps its mode.
   */
  async write(input: string, source: Readable, options: WorkspaceWriteOptions = {}): Promise<{ size: number }> {
    const { abs } = this.forWrite(input)
    source.on('error', () => {})
    let staged: string | undefined
    try {
      let parent = await this.writing(abs, async () => {
        const dir = path.dirname(abs)
        const stat = await fs.promises.stat(dir)
        if (!stat.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
        return dir
      })
      // Confined: the file goes where the parent really is, which must be inside the workspace.
      if (options.confined) parent = await this.confinedLocation(parent, true)
      const destination = path.join(parent, path.basename(abs))
      // A name of our own, not one derived from the destination: a destination
      // name as long as the filesystem allows leaves no room for a suffix.
      staged = path.join(parent, `.workspace-fs-${randomUUID()}.tmp`)
      const handle = await fs.promises.open(staged, 'wx', 0o600)
      try {
        // Chunk by chunk onto the handle, which stays ours to flush and close.
        for await (const chunk of source) {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array)
          let written = 0
          while (written < bytes.byteLength) {
            written += (await handle.write(bytes, written, bytes.byteLength - written)).bytesWritten
          }
        }
        if (options.flush) await handle.sync()
      } finally {
        await handle.close()
      }
      const existing = await fs.promises.lstat(destination).catch((error) => (isAbsence(error) ? null : fromFsError(error)))
      if (existing?.isDirectory()) throw new WorkspaceFsError('not-a-file')
      const mode = options.mode ?? (existing?.isFile() ? existing.mode & 0o777 : 0o644)
      await fs.promises.chmod(staged, mode)
      if (options.overwrite === false) {
        // The exclusive create is the collision check; the staged file then replaces that empty claim.
        await fs.promises.writeFile(destination, '', { flag: 'wx' })
      }
      await fs.promises.rename(staged, destination)
      staged = undefined
      const stat = await fs.promises.stat(destination)
      return { size: stat.size }
    } catch (error) {
      source.destroy()
      return fromWriteError(error)
    } finally {
      if (staged) await fs.promises.unlink(staged).catch(() => {})
    }
  }

  async append(input: string, bytes: Buffer): Promise<void> {
    const { abs } = this.forWrite(input)
    await appendSerialized(abs, () => this.writing(abs, () => fs.promises.appendFile(abs, bytes))).catch(fromWriteError)
  }

  async delete(input: string, options: { recursive?: boolean; confined?: boolean } = {}): Promise<void> {
    const { rel, abs } = this.absolute(input)
    if (rel === '') throw new WorkspaceFsError('invalid-path', 'The workspace root cannot be deleted')
    // lstat, not stat: a link is removed as a link, never followed.
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(abs)
    } catch (error) {
      if (isAbsence(error)) return
      return fromFsError(error)
    }
    if (stat.isDirectory() && !options.recursive) {
      throw new WorkspaceFsError('not-a-file', 'Path is a directory; delete it with recursive')
    }
    let destination = abs
    if (options.confined) {
      if (stat.isSymbolicLink()) throw new WorkspaceFsError('outside-workspace')
      destination = await this.confinedLocation(abs)
    }
    await fs.promises.rm(destination, { recursive: stat.isDirectory(), force: true }).catch(fromFsError)
  }

  async mkdir(input: string): Promise<void> {
    const { abs } = this.absolute(input)
    await ensureDirectory(abs)
  }
}

function flag(c: Context, name: string): boolean {
  return c.req.query(name) === '1'
}

function intParam(c: Context, name: string): number | undefined {
  const raw = c.req.query(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value)) throw new WorkspaceFsError('invalid-path', `Invalid ${name}`)
  return value
}

function bodyOf(c: Context): Readable {
  const body = c.req.raw.body
  return body ? Readable.fromWeb(body as import('stream/web').ReadableStream<Uint8Array>) : Readable.from([])
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof WorkspaceFsError) {
    return c.json({ error: { code: error.code, message: error.message } }, STATUS[error.code])
  }
  console.error('[workspace-fs] Operation failed:', error)
  return c.json({ error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }, 500)
}

/** Register the workspace routes on the container API. */
export function registerWorkspaceFsRoutes(app: Hono, workspaceRoot = '/workspace'): void {
  const workspace = new WorkspaceFs(workspaceRoot)
  const route = (handler: (c: Context, filePath: string) => Promise<Response>) => async (c: Context) => {
    try {
      return await handler(c, c.req.query('path') ?? '')
    } catch (error) {
      return failure(c, error)
    }
  }

  app.get(`${WORKSPACE_FS_PREFIX}/stat`, route(async (c, p) => c.json(await workspace.stat(p))))
  app.get(`${WORKSPACE_FS_PREFIX}/list`, route(async (c, p) => c.json(await workspace.list(p))))
  app.get(`${WORKSPACE_FS_PREFIX}/resolve`, route(async (c, p) => c.json({ path: await workspace.resolve(p) })))

  app.get(
    `${WORKSPACE_FS_PREFIX}/read`,
    route(async (c, p) => {
      const { size, stream } = await workspace.read(p, {
        start: intParam(c, 'start'),
        end: intParam(c, 'end'),
        lenient: flag(c, 'lenient'),
        confined: flag(c, 'confined'),
      })
      c.header('Content-Type', 'application/octet-stream')
      c.header('Cache-Control', 'private, no-store')
      c.header(WORKSPACE_FILE_SIZE_HEADER, String(size))
      return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>)
    }),
  )

  app.put(
    `${WORKSPACE_FS_PREFIX}/file`,
    route(async (c, p) => {
      const mode = intParam(c, 'mode')
      const overwrite = c.req.query('overwrite')
      return c.json(
        await workspace.write(p, bodyOf(c), {
          ...(mode !== undefined ? { mode } : {}),
          flush: flag(c, 'flush'),
          ...(overwrite !== undefined ? { overwrite: overwrite === '1' } : {}),
          confined: flag(c, 'confined'),
        }),
      )
    }),
  )

  app.post(
    `${WORKSPACE_FS_PREFIX}/append`,
    route(async (c, p) => {
      await workspace.append(p, Buffer.from(await c.req.arrayBuffer()))
      return c.json({})
    }),
  )

  app.delete(
    `${WORKSPACE_FS_PREFIX}/entry`,
    route(async (c, p) => {
      await workspace.delete(p, { recursive: flag(c, 'recursive'), confined: flag(c, 'confined') })
      return c.json({})
    }),
  )

  app.post(
    `${WORKSPACE_FS_PREFIX}/mkdir`,
    route(async (c, p) => {
      await workspace.mkdir(p)
      return c.json({})
    }),
  )
}
