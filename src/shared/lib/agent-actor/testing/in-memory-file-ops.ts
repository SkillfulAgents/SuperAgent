/**
 * `FileOps` over a map: no filesystem, no host path. The second
 * implementation the contract suite runs, and the workspace of an in-memory
 * agent actor in tests.
 */
import type { ByteRange, FileEntry, FileOps, FileStat } from '../types'
import { WorkspaceFileError, normalizeWorkspacePath, workspaceDirname } from '../workspace-path'

function ancestorsOf(rel: string): string[] {
  const out: string[] = []
  let current = workspaceDirname(rel)
  while (current !== '') {
    out.unshift(current)
    current = workspaceDirname(current)
  }
  return out
}

export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes)
      controller.close()
    },
  })
}

export class InMemoryFileOps implements FileOps {
  private readonly files = new Map<string, Uint8Array>()
  private readonly dirs = new Set<string>([''])
  private readonly mtimes = new Map<string, number>()

  /** Every file, for assertions. */
  snapshot(): Record<string, Uint8Array> {
    return Object.fromEntries(this.files)
  }

  private ensureDirs(rel: string): void {
    for (const ancestor of [...ancestorsOf(rel), rel]) {
      if (this.files.has(ancestor)) throw new WorkspaceFileError('not-a-directory', 'A file is in the way')
      if (!this.dirs.has(ancestor)) {
        this.dirs.add(ancestor)
        this.mtimes.set(ancestor, Date.now())
      }
    }
  }

  async list(dir: string): Promise<FileEntry[]> {
    const rel = normalizeWorkspacePath(dir)
    if (this.files.has(rel)) throw new WorkspaceFileError('not-a-directory')
    if (!this.dirs.has(rel)) throw new WorkspaceFileError('not-found')
    const prefix = rel === '' ? '' : `${rel}/`
    const entries: FileEntry[] = []
    for (const candidate of [...this.dirs, ...this.files.keys()]) {
      if (candidate === '' || !candidate.startsWith(prefix)) continue
      const remainder = candidate.slice(prefix.length)
      if (remainder.includes('/')) continue
      entries.push({ name: remainder, path: candidate, kind: this.dirs.has(candidate) ? 'directory' : 'file' })
    }
    return entries
  }

  async stat(workspacePath: string): Promise<FileStat | null> {
    const rel = normalizeWorkspacePath(workspacePath)
    if (this.dirs.has(rel)) return { kind: 'directory', size: 0, mtimeMs: this.mtimes.get(rel) ?? 0, resolvedPath: rel }
    const bytes = this.files.get(rel)
    if (bytes) return { kind: 'file', size: bytes.byteLength, mtimeMs: this.mtimes.get(rel) ?? 0, resolvedPath: rel }
    return null
  }

  async read(workspacePath: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    const rel = normalizeWorkspacePath(workspacePath)
    if (this.dirs.has(rel)) throw new WorkspaceFileError('not-a-file')
    const bytes = this.files.get(rel)
    if (!bytes) throw new WorkspaceFileError('not-found')
    if (range && (range.start < 0 || range.end < range.start || range.end >= bytes.byteLength)) {
      throw new WorkspaceFileError('invalid-path', 'Byte range out of bounds')
    }
    return streamOf(range ? bytes.slice(range.start, range.end + 1) : bytes)
  }

  async getDoc(workspacePath: string): Promise<Uint8Array | null> {
    const rel = normalizeWorkspacePath(workspacePath)
    if (this.dirs.has(rel)) throw new WorkspaceFileError('not-a-file')
    return this.files.get(rel) ?? null
  }

  async putDoc(workspacePath: string, bytes: Uint8Array | string): Promise<void> {
    const rel = normalizeWorkspacePath(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root is not a file')
    if (this.dirs.has(rel)) throw new WorkspaceFileError('not-a-file')
    this.ensureDirs(workspaceDirname(rel))
    this.files.set(rel, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes))
    this.mtimes.set(rel, Date.now())
  }

  async write(workspacePath: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ size: number }> {
    const bytes = body instanceof Uint8Array ? body : await readAllBytes(body)
    await this.putDoc(workspacePath, bytes)
    return { size: bytes.byteLength }
  }

  async delete(workspacePath: string, options?: { recursive?: boolean }): Promise<void> {
    const rel = normalizeWorkspacePath(workspacePath)
    if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root cannot be deleted')
    if (this.files.delete(rel)) {
      this.mtimes.delete(rel)
      return
    }
    if (!this.dirs.has(rel)) return
    if (!options?.recursive) {
      throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
    }
    const prefix = `${rel}/`
    for (const candidate of [...this.dirs]) if (candidate === rel || candidate.startsWith(prefix)) this.dirs.delete(candidate)
    for (const candidate of [...this.files.keys()]) if (candidate.startsWith(prefix)) this.files.delete(candidate)
    for (const candidate of [...this.mtimes.keys()]) if (candidate === rel || candidate.startsWith(prefix)) this.mtimes.delete(candidate)
  }

  async mkdir(workspacePath: string): Promise<void> {
    this.ensureDirs(normalizeWorkspacePath(workspacePath))
  }
}
