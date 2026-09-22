import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export const WORKSPACE_ROOT = '/workspace'

type WorkspaceFileStatus = 400 | 403 | 404 | 409

export class WorkspaceFileError extends Error {
  constructor(message: string, readonly status: WorkspaceFileStatus) {
    super(message)
    this.name = 'WorkspaceFileError'
  }
}

export interface WorkspaceFileMetadata {
  path: string
  relativePath: string
  localPath: string
  size: number
  modifiedAt: Date
}

export interface OpenWorkspaceFile extends WorkspaceFileMetadata {
  stream: Readable
}

export type WorkspaceBinarySource =
  | Readable
  | globalThis.ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>

export interface WriteWorkspaceFileOptions {
  workspaceRoot?: string
  signal?: AbortSignal
  overwrite?: boolean
  collisionSafe?: boolean
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function logicalPath(relativePath: string): string {
  return `${WORKSPACE_ROOT}/${relativePath}`
}

/** Normalize an agent path into a path below the supplied physical workspace. */
export function normalizeWorkspaceFilePath(
  rawPath: string,
  workspaceRoot = WORKSPACE_ROOT,
): { path: string; relativePath: string; localPath: string } {
  if (!rawPath || rawPath.includes('\0')) {
    throw new WorkspaceFileError('Invalid workspace file path', 400)
  }

  const slashPath = rawPath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(slashPath)) {
    throw new WorkspaceFileError('File path is outside /workspace', 403)
  }

  let relativePath: string
  if (path.posix.isAbsolute(slashPath)) {
    const normalized = path.posix.normalize(slashPath)
    relativePath = path.posix.relative(WORKSPACE_ROOT, normalized)
    if (relativePath === '..' || relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)) {
      throw new WorkspaceFileError('File path is outside /workspace', 403)
    }
  } else {
    relativePath = path.posix.normalize(slashPath)
  }

  const rawSegments = slashPath.split('/')
  if (rawSegments.includes('..')) {
    throw new WorkspaceFileError('Workspace path traversal is not allowed', 400)
  }
  if (!relativePath || relativePath === '.') {
    throw new WorkspaceFileError('Workspace root is not a file', 400)
  }

  const localPath = path.resolve(workspaceRoot, ...relativePath.split('/'))
  const resolvedRoot = path.resolve(workspaceRoot)
  if (!isContained(resolvedRoot, localPath) || localPath === resolvedRoot) {
    throw new WorkspaceFileError('File path is outside /workspace', 403)
  }

  return { path: logicalPath(relativePath), relativePath, localPath }
}

function mapAccessError(error: unknown): never {
  if (error instanceof WorkspaceFileError) throw error
  if (errorCode(error) === 'ENOENT') throw new WorkspaceFileError('File not found', 404)
  if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
    throw new WorkspaceFileError('File is not accessible', 403)
  }
  throw error
}

async function assertOpenedHandleContained(
  handle: fs.promises.FileHandle,
  workspaceRoot: string,
): Promise<void> {
  const [canonicalRoot, openedPath] = await Promise.all([
    fs.promises.realpath(workspaceRoot),
    fs.promises.realpath(`/proc/self/fd/${handle.fd}`),
  ])
  if (!isContained(canonicalRoot, openedPath) || openedPath === canonicalRoot) {
    throw new WorkspaceFileError('Opened file resolves outside /workspace', 403)
  }
}

/** Resolve an existing regular file and prove its canonical path stays confined. */
export async function resolveWorkspaceRegularFile(
  rawPath: string,
  workspaceRoot = WORKSPACE_ROOT,
): Promise<WorkspaceFileMetadata> {
  const normalized = normalizeWorkspaceFilePath(rawPath, workspaceRoot)
  try {
    const [canonicalRoot, canonicalFile] = await Promise.all([
      fs.promises.realpath(workspaceRoot),
      fs.promises.realpath(normalized.localPath),
    ])
    if (!isContained(canonicalRoot, canonicalFile) || canonicalFile === canonicalRoot) {
      throw new WorkspaceFileError('File resolves outside /workspace', 403)
    }
    const stats = await fs.promises.stat(canonicalFile)
    if (!stats.isFile()) {
      throw new WorkspaceFileError('Path is not a regular file', 400)
    }
    return {
      ...normalized,
      localPath: canonicalFile,
      size: stats.size,
      modifiedAt: stats.mtime,
    }
  } catch (error) {
    return mapAccessError(error)
  }
}

/** Open a confined regular file as bytes, with metadata from the opened handle. */
export async function openWorkspaceFile(
  rawPath: string,
  workspaceRoot = WORKSPACE_ROOT,
): Promise<OpenWorkspaceFile> {
  const resolved = await resolveWorkspaceRegularFile(rawPath, workspaceRoot)
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(resolved.localPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    await assertOpenedHandleContained(handle, workspaceRoot)
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new WorkspaceFileError('Path is not a regular file', 400)
    }
    const stream = stats.size === 0
      ? Readable.from([])
      : handle.createReadStream({ start: 0, end: stats.size - 1 })
    if (stats.size === 0) {
      await handle.close()
      handle = undefined
    }
    return {
      ...resolved,
      size: stats.size,
      modifiedAt: stats.mtime,
      // Bind the response to the opened snapshot size. A concurrently growing
      // file must not emit bytes beyond the advertised Content-Length.
      stream,
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    return mapAccessError(error)
  }
}

async function canonicalDestinationParent(
  relativePath: string,
  workspaceRoot: string,
): Promise<{ canonicalRoot: string; parent: string }> {
  const canonicalRoot = await fs.promises.realpath(workspaceRoot).catch((error) => mapAccessError(error))
  const parentSegments = path.posix.dirname(relativePath).split('/').filter((segment) => segment && segment !== '.')
  let parent = canonicalRoot

  for (const segment of parentSegments) {
    const candidate = path.join(parent, segment)
    try {
      await fs.promises.mkdir(candidate)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }

    const canonicalCandidate = await fs.promises.realpath(candidate).catch((error) => mapAccessError(error))
    if (!isContained(canonicalRoot, canonicalCandidate)) {
      throw new WorkspaceFileError('Destination parent resolves outside /workspace', 403)
    }
    const stats = await fs.promises.stat(canonicalCandidate)
    if (!stats.isDirectory()) {
      throw new WorkspaceFileError('Destination parent is not a directory', 400)
    }
    parent = canonicalCandidate
  }

  return { canonicalRoot, parent }
}

async function lstatIfPresent(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function suffixedFilename(filename: string, attempt: number): string {
  if (attempt === 0) return filename
  const extension = path.extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  return `${stem}-${attempt}${extension}`
}

function readableSource(source: WorkspaceBinarySource | null): Readable {
  if (source === null) return Readable.from([])
  if (source instanceof Readable) return source
  if (Symbol.asyncIterator in source) return Readable.from(source)
  return Readable.fromWeb(source)
}

/** Stream bytes to a same-directory temporary file, then atomically publish it. */
export async function writeWorkspaceFile(
  rawPath: string,
  source: WorkspaceBinarySource | null,
  options: WriteWorkspaceFileOptions = {},
): Promise<WorkspaceFileMetadata> {
  const workspaceRoot = options.workspaceRoot ?? WORKSPACE_ROOT
  const normalized = normalizeWorkspaceFilePath(rawPath, workspaceRoot)
  const { canonicalRoot, parent } = await canonicalDestinationParent(normalized.relativePath, workspaceRoot)
  if (!isContained(canonicalRoot, parent)) {
    throw new WorkspaceFileError('Destination parent resolves outside /workspace', 403)
  }

  const requestedFilename = path.posix.basename(normalized.relativePath)
  const collisionSafe = options.collisionSafe ?? false
  const overwrite = collisionSafe ? false : (options.overwrite ?? true)
  let tempHandle: fs.promises.FileHandle | undefined
  let tempPath: string | undefined
  try {
    // Stage once: a publication collision can retry without rereading the source.
    tempPath = path.join(parent, `.x-agent-${randomUUID()}.tmp`)
    tempHandle = await fs.promises.open(tempPath, 'wx', 0o600)
    await assertOpenedHandleContained(tempHandle, workspaceRoot)
    const output = tempHandle.createWriteStream({ autoClose: true })
    await pipeline(readableSource(source), output, { signal: options.signal })
    tempHandle = undefined

    for (let attempt = 0; attempt < (collisionSafe ? 1000 : 1); attempt++) {
      options.signal?.throwIfAborted()
      const filename = suffixedFilename(requestedFilename, attempt)
      const destination = path.join(parent, filename)
      const currentParent = await fs.promises.realpath(parent)
      if (currentParent !== parent || !isContained(canonicalRoot, currentParent)) {
        throw new WorkspaceFileError('Destination parent changed during upload', 409)
      }
      if (overwrite) {
        const existing = await lstatIfPresent(destination)
        if (existing?.isSymbolicLink()) throw new WorkspaceFileError('Destination must not be a symbolic link', 400)
        if (existing && !existing.isFile()) throw new WorkspaceFileError('Destination is not a regular file', 400)
        if (existing) await fs.promises.chmod(tempPath, existing.mode & 0o7777)
        await fs.promises.rename(tempPath, destination)
      } else {
        // The atomic link is the collision check, including competing writers
        // that do not use this helper. Never replace their destination.
        try {
          await fs.promises.link(tempPath, destination)
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error
          if (collisionSafe) continue
          throw new WorkspaceFileError('File already exists', 409)
        }
        await fs.promises.unlink(tempPath)
      }
      tempPath = undefined
      const stats = await fs.promises.stat(destination)
      const relativeDir = path.posix.dirname(normalized.relativePath)
      const relativePath = relativeDir === '.' ? filename : path.posix.join(relativeDir, filename)
      return { path: logicalPath(relativePath), relativePath, localPath: destination, size: stats.size, modifiedAt: stats.mtime }
    }
    throw new WorkspaceFileError('Could not find an available filename', 409)
  } catch (error) {
    if (errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM') {
      throw new WorkspaceFileError('Destination is not writable', 403)
    }
    throw error
  } finally {
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {})
    await tempHandle?.close().catch(() => {})
  }
}
