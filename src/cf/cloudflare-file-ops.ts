/**
 * An agent's files when its workspace lives only inside its Cloudflare Container, as
 * local-file-ops.ts is for a workspace on this machine. While the container runs, every operation
 * is a call to the container's file API. While it does not, every operation goes to the saved
 * workspace (AgentDurableObject's file list and R2), which the next start restores.
 *
 * A file operation never wakes the container: starting it reads the agent's config through these
 * same operations, so a wake from here would wait on itself.
 */
import type { FileEntry, FileStat, OpenFile, StoreFileOps } from '@shared/lib/agent-actor/types'
import { WorkspaceFileError, normalizeWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
import { ASLEEP_HEADER, type SleepingStore, type StoredEntry } from './cloudflare-container-control'

/** Calls the container's API, or returns null when the container is not running. */
export type ContainerFetch = (path: string, init?: RequestInit) => Promise<Response | null>

/** At most this many bytes per chunk of a saved file: each chunk crosses as one message. */
const CHUNK_BYTES = 64 * 1024

const encodePath = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')
const toBytes = (bytes: Uint8Array | string) => (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)

async function failed(response: Response, rel: string): Promise<never> {
  if (response.status === 404) throw new WorkspaceFileError('not-found')
  if (response.status === 403) throw new WorkspaceFileError('outside-workspace')
  const body = await response.text().catch(() => '')
  throw new Error(`Container file API ${response.status} for ${rel || '/'}: ${body.slice(0, 200)}`)
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body
  return new Uint8Array(await new Response(body).arrayBuffer())
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close()
      controller.enqueue(bytes.subarray(offset, (offset += CHUNK_BYTES)))
    },
  })
}

const slice = (bytes: Uint8Array, range?: { start: number; end?: number }) =>
  range ? bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : bytes

export function createCloudflareFileOps(callContainer: ContainerFetch, sleeping: SleepingStore): StoreFileOps {
  // The container's answer, or null when it is not running or its object answers asleep.
  const awake = async (path: string, init?: RequestInit): Promise<Response | null> => {
    const response = await callContainer(path, init)
    return response && !(response.status === 503 && response.headers.get(ASLEEP_HEADER) === '1') ? response : null
  }

  const info = async (rel: string): Promise<StoredEntry | StoredEntry[] | null> => {
    const response = await awake(`/files/${encodePath(rel)}`)
    if (!response) return sleeping.entry(rel)
    if (response.status === 404) return null
    if (!response.ok) return failed(response, rel)
    return (await response.json()) as StoredEntry | StoredEntry[]
  }

  const content = async (rel: string): Promise<Uint8Array> => {
    const found = await info(rel)
    if (!found) throw new WorkspaceFileError('not-found')
    if (Array.isArray(found)) throw new WorkspaceFileError('not-a-file')
    const response = await awake(`/files/${encodePath(rel)}/content`)
    if (response) {
      if (!response.ok) return failed(response, rel)
      return new Uint8Array(await response.arrayBuffer())
    }
    const bytes = await sleeping.read(rel)
    if (!bytes) throw new WorkspaceFileError('not-found')
    return bytes
  }

  // Running, the container streams the file, or the range asked for; asleep, the saved copy is read whole.
  const contentStream = async (rel: string, range?: { start: number; end?: number }): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> => {
    const found = await info(rel)
    if (!found) throw new WorkspaceFileError('not-found')
    if (Array.isArray(found)) throw new WorkspaceFileError('not-a-file')
    const init = range ? { headers: { Range: `bytes=${range.start}-${range.end ?? ''}` } } : undefined
    const response = await awake(`/files/${encodePath(rel)}/content`, init)
    if (response) {
      if (!response.ok || !response.body) return failed(response, rel)
      return { size: found.size ?? 0, stream: response.body }
    }
    const bytes = await sleeping.read(rel)
    if (!bytes) throw new WorkspaceFileError('not-found')
    return { size: bytes.byteLength, stream: streamOf(slice(bytes, range)) }
  }

  // Asleep, the change goes to the saved workspace; if the container started meanwhile, to it.
  const change = async (rel: string, inContainer: () => Promise<Response | null>, asleep: () => Promise<boolean>, missingIsOk = false) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await inContainer()
      if (response) {
        if (missingIsOk && response.status === 404) return
        if (!response.ok) await failed(response, rel)
        return
      }
      if (await asleep()) return
    }
    throw new Error(`The container for ${rel || '/'} kept starting and stopping`)
  }

  const upload = (rel: string, bytes: Uint8Array) =>
    change(
      rel,
      () => awake(`/files/${encodePath(rel)}/upload`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> }),
      () => sleeping.write(rel, bytes),
    )

  const files: StoreFileOps = {
    async list(dir) {
      const rel = dir ? normalizeWorkspacePath(dir) : ''
      const found = await info(rel)
      if (!found) return []
      if (!Array.isArray(found)) throw new WorkspaceFileError('not-a-directory')
      return found.map((entry): FileEntry => ({ name: entry.name, path: entry.path, kind: entry.type }))
    },

    async stat(path) {
      const found = await info(normalizeWorkspacePath(path))
      if (!found) return null
      if (Array.isArray(found)) return { kind: 'directory', size: 0, mtimeMs: 0 }
      return { kind: found.type, size: found.size ?? 0, mtimeMs: found.modifiedAt ? Date.parse(found.modifiedAt) : 0 } satisfies FileStat
    },

    async resolve(path) {
      const rel = normalizeWorkspacePath(path)
      return (await info(rel)) ? rel : null
    },

    async read(path, range) {
      return (await contentStream(normalizeWorkspacePath(path), range)).stream
    },

    async readSized(path) {
      return contentStream(normalizeWorkspacePath(path))
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

    // A stream goes to a running container as it arrives, so a large upload is never whole in
    // memory. Asleep, the saved workspace hashes the whole file, so it is read first.
    async write(path, body) {
      const rel = normalizeWorkspacePath(path)
      if (body instanceof Uint8Array) {
        await upload(rel, body)
        return { size: body.byteLength }
      }
      let size = 0
      const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength
          controller.enqueue(chunk)
        },
      }))
      const response = await callContainer(`/files/${encodePath(rel)}/upload`, { method: 'POST', body: counted })
      if (response && !(response.status === 503 && response.headers.get(ASLEEP_HEADER) === '1')) {
        if (!response.ok) await failed(response, rel)
        return { size }
      }
      // The container went to sleep after taking (part of) the stream: it cannot be sent again.
      if (response) throw new Error(`The container stopped while ${rel} was being sent; try the upload again`)
      const bytes = await readAll(counted)
      await upload(rel, bytes)
      return { size: bytes.byteLength }
    },

    async delete(path) {
      const rel = normalizeWorkspacePath(path)
      await change(rel, () => awake(`/files/${encodePath(rel)}`, { method: 'DELETE' }), () => sleeping.remove(rel), true)
    },

    // The saved workspace keeps files only: a folder exists while something is in it.
    async mkdir(path) {
      const rel = path ? normalizeWorkspacePath(path) : ''
      if (!rel) return
      const response = await awake(`/files/${encodePath(rel)}/mkdir`, { method: 'POST' })
      if (response && !response.ok) await failed(response, rel)
    },

    // The container has no append endpoint: read and rewrite. Not atomic against a concurrent
    // writer inside the container.
    async append(path, bytes) {
      const rel = normalizeWorkspacePath(path)
      const current = (await files.getDoc(rel)) ?? new Uint8Array()
      const added = toBytes(bytes)
      const next = new Uint8Array(current.byteLength + added.byteLength)
      next.set(current)
      next.set(added, current.byteLength)
      await upload(rel, next)
    },

    // One fetch per open: the transcript reader pages through it with many readAt calls.
    async open(path): Promise<OpenFile> {
      const rel = normalizeWorkspacePath(path)
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
          return streamOf(slice(all, range))
        },
        close: async () => {
          bytes = null
        },
      }
    },
  }
  return files
}
