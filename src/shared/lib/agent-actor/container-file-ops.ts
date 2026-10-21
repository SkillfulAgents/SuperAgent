/**
 * `FileOps` and `ConfigOps` for an agent whose workspace lives only inside its
 * container (Cloudflare Containers): every operation is a call to the
 * container's file API.
 *
 * A file operation never wakes the container: starting it reads the agent's
 * config through these same operations, so a wake from here waits on itself.
 * While it is asleep, reads see only what was written since, and writes are
 * held and sent on the first call after it is running again.
 */
import { createConfigOps } from './config-ops'
import type { ByteRange, ConfigOps, FileEntry, FileOps, FileStat, OpenFile } from './types'
import { WorkspaceFileError, normalizeWorkspacePath } from './workspace-path'

/** Calls the container's API, or returns null when the container is not running. */
export type ContainerFetch = (path: string, init?: RequestInit) => Promise<Response | null>

interface ContainerEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modifiedAt?: string
}

const encodePath = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')

async function failed(response: Response, rel: string): Promise<never> {
  if (response.status === 404) throw new WorkspaceFileError('not-found')
  if (response.status === 403) throw new WorkspaceFileError('outside-workspace')
  const body = await response.text().catch(() => '')
  throw new Error(`Container file API ${response.status} for ${rel || '/'}: ${body.slice(0, 200)}`)
}

function toBytes(bytes: Uint8Array | string): Uint8Array {
  return typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body
  return new Uint8Array(await new Response(body).arrayBuffer())
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

export function createContainerFileOps(callContainer: ContainerFetch): FileOps {
  // Writes made while the container was asleep, by workspace path; null is a delete.
  const held = new Map<string, Uint8Array | null>()

  const flush = async () => {
    for (const [rel, bytes] of [...held]) {
      const response = bytes
        ? await callContainer(`/files/${encodePath(rel)}/upload`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> })
        : await callContainer(`/files/${encodePath(rel)}`, { method: 'DELETE' })
      if (!response) return
      if (!response.ok && response.status !== 404) await failed(response, rel)
      held.delete(rel)
    }
  }

  const ASLEEP = new Response(null, { status: 503 })
  const fetchContainer = async (path: string, init?: RequestInit): Promise<Response> => {
    if (held.size > 0) await flush()
    return (await callContainer(path, init)) ?? ASLEEP.clone()
  }
  const asleep = (response: Response) => response.status === 503 && response.body === null

  const info = async (rel: string): Promise<ContainerEntry | ContainerEntry[] | null> => {
    if (held.has(rel)) {
      const bytes = held.get(rel)
      return bytes ? { name: rel.split('/').pop() ?? rel, path: rel, type: 'file', size: bytes.byteLength } : null
    }
    const response = await fetchContainer(`/files/${encodePath(rel)}`)
    if (response.status === 404 || asleep(response)) return null
    if (!response.ok) return failed(response, rel)
    return (await response.json()) as ContainerEntry | ContainerEntry[]
  }

  const content = async (rel: string): Promise<Uint8Array> => {
    const found = await info(rel)
    if (!found) throw new WorkspaceFileError('not-found')
    if (Array.isArray(found)) throw new WorkspaceFileError('not-a-file')
    const pending = held.get(rel)
    if (pending) return pending
    const response = await fetchContainer(`/files/${encodePath(rel)}/content`)
    if (!response.ok) return failed(response, rel)
    return new Uint8Array(await response.arrayBuffer())
  }

  const upload = async (rel: string, bytes: Uint8Array): Promise<void> => {
    const response = await fetchContainer(`/files/${encodePath(rel)}/upload`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> })
    if (asleep(response)) {
      held.set(rel, bytes)
      return
    }
    if (!response.ok) await failed(response, rel)
  }

  const ops: FileOps = {
    async list(dir) {
      const rel = dir ? normalizeWorkspacePath(dir) : ''
      const found = await info(rel)
      if (!found) return []
      if (!Array.isArray(found)) throw new WorkspaceFileError('not-a-directory')
      return found.map((entry): FileEntry => ({ name: entry.name, path: entry.path, kind: entry.type }))
    },

    async stat(path) {
      const rel = normalizeWorkspacePath(path)
      const found = await info(rel)
      if (!found) return null
      if (Array.isArray(found)) return { kind: 'directory', size: 0, mtimeMs: 0 }
      return {
        kind: found.type,
        size: found.size ?? 0,
        mtimeMs: found.modifiedAt ? Date.parse(found.modifiedAt) : 0,
      } satisfies FileStat
    },

    async resolve(path) {
      const rel = normalizeWorkspacePath(path)
      return (await info(rel)) ? rel : null
    },

    async read(path, range?: ByteRange) {
      const bytes = await content(normalizeWorkspacePath(path))
      return streamOf(range ? bytes.subarray(range.start, range.end + 1) : bytes)
    },

    async getDoc(path) {
      try {
        return await content(normalizeWorkspacePath(path))
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.code === 'not-found') return null
        throw error
      }
    },

    async putDoc(path, bytes) {
      await upload(normalizeWorkspacePath(path), toBytes(bytes))
    },

    async write(path, body) {
      const bytes = await readAll(body)
      await upload(normalizeWorkspacePath(path), bytes)
      return { size: bytes.byteLength }
    },

    async delete(path) {
      const rel = normalizeWorkspacePath(path)
      const response = await fetchContainer(`/files/${encodePath(rel)}`, { method: 'DELETE' })
      if (asleep(response)) {
        held.set(rel, null)
        return
      }
      if (response.status === 404) return
      if (!response.ok) await failed(response, rel)
    },

    async mkdir(path) {
      const rel = path ? normalizeWorkspacePath(path) : ''
      if (!rel) return
      const response = await fetchContainer(`/files/${encodePath(rel)}/mkdir`, { method: 'POST' })
      if (asleep(response)) return
      if (!response.ok) await failed(response, rel)
    },

    // The container has no append endpoint: read and rewrite. Not atomic
    // against a concurrent writer inside the container.
    async append(path, bytes) {
      const rel = normalizeWorkspacePath(path)
      const current = (await ops.getDoc(rel)) ?? new Uint8Array()
      const added = toBytes(bytes)
      const next = new Uint8Array(current.byteLength + added.byteLength)
      next.set(current)
      next.set(added, current.byteLength)
      await upload(rel, next)
    },

    async open(path): Promise<OpenFile> {
      const rel = normalizeWorkspacePath(path)
      // One fetch per open: the transcript reader pages through it with many readAt calls.
      let bytes: Uint8Array | null = await content(rel)
      const current = () => {
        if (!bytes) throw new Error(`${rel} is closed`)
        return bytes
      }
      return {
        size: async () => current().byteLength,
        readAt: async (offset, length) => current().slice(offset, offset + length),
        stream: (range) => {
          const all = current()
          bytes = null
          return streamOf(range ? all.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : all)
        },
        close: async () => {
          bytes = null
        },
      }
    },
  }
  return ops
}

/** No disk lock to take: updates to a document serialize within this process. */
export function createContainerConfigOps(files: FileOps): ConfigOps {
  return createConfigOps(files)
}
