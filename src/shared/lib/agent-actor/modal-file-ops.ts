/**
 * Workspace file operations for an agent whose workspace is a Modal volume.
 *
 * Reads go to the volume's own API, never through the agent's sandbox, so
 * the files of a sleeping agent are read without waking it. Writes go to the
 * volume too while the agent sleeps; while its sandbox runs they go through
 * the sandbox instead, because a running sandbox sees the volume as it was
 * when it started and cannot reload it while the agent holds files open.
 * Written through the sandbox, a file is in the agent's view at once and is
 * committed to the volume before the write returns, so the next read here
 * sees it as well.
 *
 * Containment is lexical and complete: the volume has no links a path could
 * follow out, so `resolve` echoes the normalized path. Two things differ from
 * a directory on this machine. The volume knows no empty directories, so
 * `mkdir` leaves a marker file that listings hide. And a write is
 * whole-file: `write` gathers its stream before uploading, so a very large
 * upload is bounded by memory, which this spike accepts.
 */
import type { ByteRange, FileEntry, FileOps, FileStat, WriteOptions } from './types'
import { WorkspaceFileError, normalizeWorkspacePath, workspaceBasename } from './workspace-path'
import { ModalVolumeError, type ModalVolumeFiles } from '@shared/lib/container/modal/modal-volume'
import { SandboxExecError, type LiveWorkspace } from '@shared/lib/container/modal/sandbox-workspace'

/** The file that stands in for an empty directory. Hidden from listings. */
export const DIRECTORY_MARKER = '.keep'

/**
 * The mode a file written from this host gets on the volume. The sandbox
 * sees host-written files as root's while the agent runs as the image's
 * user, so a plain 0644 would be a file the agent can read but never edit,
 * its own CLAUDE.md included. Every mode is widened to be writable by anyone
 * in the sandbox; the bits the caller asked for (an executable's) are kept.
 */
export function agentWritableMode(requested?: number): number {
  return (requested ?? 0o644) | 0o666
}

/** Translate a volume error into the contract's error, or rethrow it. */
function fromVolumeError(error: unknown): never {
  if (error instanceof ModalVolumeError) {
    switch (error.code) {
      case 'not-found':
        throw new WorkspaceFileError('not-found')
      case 'is-a-directory':
        throw new WorkspaceFileError('not-a-file')
      case 'not-a-directory':
      case 'directory-not-empty':
        throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
      case 'already-exists':
        throw new WorkspaceFileError('invalid-path', error.message)
    }
  }
  throw error
}

/** Translate a failed sandbox command into the contract's error, or rethrow it. */
function fromSandboxError(error: unknown): never {
  if (error instanceof SandboxExecError) {
    if (/Not a directory/i.test(error.stderr)) throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
    if (/Is a directory/i.test(error.stderr)) throw new WorkspaceFileError('not-a-file')
    if (/Permission denied/i.test(error.stderr)) throw new WorkspaceFileError('not-accessible')
  }
  throw error
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export interface ModalFileOpsHooks {
  /** The agent's workspace as its running sandbox sees it, or null while the agent sleeps. */
  live?: () => LiveWorkspace | null
}

export class ModalFileOps implements FileOps {
  constructor(
    private readonly volume: () => Promise<ModalVolumeFiles>,
    private readonly hooks: ModalFileOpsHooks = {},
  ) {}

  /** A path to write at: any workspace path but the root. */
  private forWrite(workspacePath: string): string {
    const rel = normalizeWorkspacePath(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root is not a file')
    return rel
  }

  private live(): LiveWorkspace | null {
    return this.hooks.live?.() ?? null
  }

  async list(dir: string): Promise<FileEntry[]> {
    const rel = normalizeWorkspacePath(dir)
    const volume = await this.volume()
    let entries
    try {
      entries = await volume.list(rel)
    } catch (error) {
      // The root exists by definition; it is empty until the first write.
      if (rel === '' && error instanceof ModalVolumeError && error.code === 'not-found') return []
      if (error instanceof ModalVolumeError && error.code === 'not-a-directory') throw new WorkspaceFileError('not-a-directory')
      return fromVolumeError(error)
    }
    // Listing a file answers with the file itself.
    if (rel !== '' && entries.length === 1 && entries[0].path === rel && entries[0].kind !== 'directory') {
      throw new WorkspaceFileError('not-a-directory')
    }
    return entries
      .filter((entry) => entry.kind !== 'other')
      .map((entry) => ({ name: workspaceBasename(entry.path), path: entry.path, kind: entry.kind as FileEntry['kind'] }))
      .filter((entry) => entry.name !== DIRECTORY_MARKER)
  }

  async stat(workspacePath: string): Promise<FileStat | null> {
    const rel = normalizeWorkspacePath(workspacePath)
    const entry = await (await this.volume()).entry(rel)
    if (!entry || entry.kind === 'other') return null
    return { kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs }
  }

  async resolve(workspacePath: string): Promise<string | null> {
    const rel = normalizeWorkspacePath(workspacePath)
    return (await this.stat(rel)) ? rel : null
  }

  async read(workspacePath: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const rel = normalizeWorkspacePath(workspacePath)
    const volume = await this.volume()
    if (range) {
      const entry = await volume.entry(rel)
      if (!entry) throw new WorkspaceFileError('not-found')
      if (entry.kind !== 'file') throw new WorkspaceFileError('not-a-file')
      if (range.start < 0 || range.end < range.start || range.end >= entry.size) {
        throw new WorkspaceFileError('invalid-path', 'Byte range out of bounds')
      }
    }
    try {
      return (await volume.readStream(rel, range)).stream
    } catch (error) {
      return fromVolumeError(error)
    }
  }

  async getDoc(workspacePath: string): Promise<Uint8Array | null> {
    const rel = normalizeWorkspacePath(workspacePath)
    try {
      return await (await this.volume()).read(rel)
    } catch (error) {
      if (error instanceof ModalVolumeError && error.code === 'not-found') return null
      return fromVolumeError(error)
    }
  }

  /** Replace a file: through the running sandbox when there is one, else on the volume. */
  private async replace(rel: string, bytes: Uint8Array, options?: WriteOptions): Promise<void> {
    const mode = agentWritableMode(options?.mode)
    const live = this.live()
    if (live) {
      await live.write(rel, bytes, mode).catch(fromSandboxError)
      return
    }
    await (await this.volume()).put(rel, bytes, { mode }).catch(fromVolumeError)
  }

  async putDoc(workspacePath: string, bytes: Uint8Array | string, options?: WriteOptions): Promise<void> {
    const rel = this.forWrite(workspacePath)
    await this.replace(rel, typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes, options)
  }

  async write(
    workspacePath: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: WriteOptions,
  ): Promise<{ size: number }> {
    let rel: string
    try {
      rel = this.forWrite(workspacePath)
    } catch (error) {
      if (!(body instanceof Uint8Array)) await body.cancel().catch(() => {})
      throw error
    }
    const data = body instanceof Uint8Array ? body : await collect(body)
    await this.replace(rel, data, options)
    return { size: data.byteLength }
  }

  async delete(workspacePath: string, options?: { recursive?: boolean }): Promise<void> {
    const rel = normalizeWorkspacePath(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root cannot be deleted')
    const live = this.live()
    if (live) {
      const kind = await live.stat(rel).catch(fromSandboxError)
      if (!kind) return
      if (kind === 'directory' && !options?.recursive) {
        throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
      }
      await live.remove(rel, kind === 'directory').catch(fromSandboxError)
      return
    }
    const volume = await this.volume()
    const entry = await volume.entry(rel)
    if (!entry) return
    if (entry.kind === 'directory' && !options?.recursive) {
      throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
    }
    try {
      await volume.remove(rel, entry.kind === 'directory')
    } catch (error) {
      if (error instanceof ModalVolumeError && error.code === 'not-found') return
      fromVolumeError(error)
    }
  }

  async mkdir(workspacePath: string): Promise<void> {
    const rel = normalizeWorkspacePath(workspacePath)
    // The root exists by definition.
    if (rel === '') return
    const live = this.live()
    if (live) {
      const kind = await live.stat(rel).catch(fromSandboxError)
      if (kind === 'directory') return
      if (kind === 'file') throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
      await live.mkdir(rel, DIRECTORY_MARKER, agentWritableMode()).catch(fromSandboxError)
      return
    }
    const volume = await this.volume()
    const entry = await volume.entry(rel)
    if (entry?.kind === 'directory') return
    if (entry) throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
    await volume.put(`${rel}/${DIRECTORY_MARKER}`, new Uint8Array(0), { mode: agentWritableMode() }).catch(fromVolumeError)
  }
}
