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
import { UploadTooLargeError } from '@shared/lib/utils/chunked-upload'
import { ASLEEP_HEADER, type ByteRange, type SleepingStore, type StoredEntry, type StoredRefusal } from './cloudflare-container-control'

/** Calls the container's API, or returns null when the container is not running. */
export type ContainerFetch = (path: string, init?: RequestInit) => Promise<Response | null>

/**
 * The largest file written whole while the agent sleeps. The saved workspace hashes a file before
 * it stores it, so it is read whole: its chunks and then their joined copy, twice its size at the
 * peak. An isolate has 128 MB for the app, every object it hosts and this, and going over resets
 * every object in it, so the file is kept well under a quarter of that.
 */
export const MAX_ASLEEP_WRITE_BYTES = 16 * 1024 * 1024

/**
 * A file up to this size is read once when it is opened: its reader pages through it with many
 * readAt calls. A larger one (a session's transcript runs to tens of MB) is read by range.
 */
const OPEN_WHOLE_BYTES = 1024 * 1024

/** At most this many bytes per chunk of a saved file: each chunk crosses as one message. */
const CHUNK_BYTES = 64 * 1024

const encodePath = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')
/** The upload's `mode` query, as the container's file routes take it: permission bits in octal. */
const modeQuery = (mode?: number) => (mode === undefined ? '' : `?mode=${(mode & 0o777).toString(8).padStart(3, '0')}`)
const toBytes = (bytes: Uint8Array | string) => (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)

/** The workspace path of a file to write: the root is a folder, never a file. */
function filePath(path: string): string {
  const rel = normalizeWorkspacePath(path)
  if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root is not a file')
  return rel
}

async function failed(response: Response, rel: string): Promise<never> {
  if (response.status === 404) throw new WorkspaceFileError('not-found')
  if (response.status === 403) throw new WorkspaceFileError('outside-workspace')
  const body = await response.text().catch(() => '')
  // A file or folder in the way: the container names which.
  if (response.status === 409) {
    const code = (() => {
      try {
        return (JSON.parse(body) as { code?: unknown }).code
      } catch {
        return undefined
      }
    })()
    if (code === 'not-a-file' || code === 'not-a-directory') throw new WorkspaceFileError(code)
  }
  throw new Error(`Container file API ${response.status} for ${rel || '/'}: ${body.slice(0, 200)}`)
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body
  return new Uint8Array(await new Response(body).arrayBuffer())
}

/** A file too large to save while the agent sleeps: an upload route answers it as 413, with what to do instead. */
export class AsleepUploadTooLargeError extends UploadTooLargeError {
  constructor(size: number, limit: number, rel: string) {
    super(size, limit)
    this.message = `${rel} is larger than ${limit / (1024 * 1024)} MB, the most that can be saved while the agent sleeps; start the agent and send the file again`
  }
}

/** Reads a stream whole, and fails it once it passes `limit` bytes instead of reading on. */
async function readUpTo(body: ReadableStream<Uint8Array>, limit: number, rel: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new AsleepUploadTooLargeError(size, limit, rel)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
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

const emptyStream = (): ReadableStream<Uint8Array> => new ReadableStream({ start: (controller) => controller.close() })

/** A stream whose source is asked for at its first read. */
function lazyStream(open: () => Promise<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  return new ReadableStream({
    async pull(controller) {
      reader ??= (await open()).getReader()
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel: (reason) => reader?.cancel(reason),
  })
}

const slice = (bytes: Uint8Array, range?: ByteRange) =>
  range ? bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : bytes

function inChunks(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) controller.enqueue(chunk.subarray(offset, offset + CHUNK_BYTES))
    },
  }))
}

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
    const saved = await sleeping.read(rel)
    if (!saved) throw new WorkspaceFileError('not-found')
    return readAll(saved.stream)
  }

  // The file's bytes, or the range asked for, without asking first whether the file is there: null when it is not.
  const bytesStream = async (rel: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> => {
    const init = range ? { headers: { Range: `bytes=${range.start}-${range.end ?? ''}` } } : undefined
    const response = await awake(`/files/${encodePath(rel)}/content`, init)
    if (response) {
      if (response.status === 404) return null
      // The range starts at or past the end of the file: there is nothing to read.
      if (response.status === 416) {
        await response.body?.cancel()
        return emptyStream()
      }
      if (!response.ok || !response.body) return failed(response, rel)
      return response.body
    }
    const saved = await sleeping.read(rel, range)
    return saved ? inChunks(saved.stream) : null
  }

  // The file, or the range asked for, streamed: from the container while it runs, else from the saved workspace.
  const contentStream = async (rel: string, range?: ByteRange): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> => {
    const found = await info(rel)
    if (!found) throw new WorkspaceFileError('not-found')
    if (Array.isArray(found)) throw new WorkspaceFileError('not-a-file')
    const size = found.size ?? 0
    // A closed range inside the file, as a local read takes it.
    if (range && (range.start < 0 || (range.end !== undefined && (range.end < range.start || range.end >= size)))) {
      throw new WorkspaceFileError('invalid-path', 'Byte range out of bounds')
    }
    const stream = await bytesStream(rel, range)
    if (!stream) throw new WorkspaceFileError('not-found')
    return { size, stream }
  }

  // Asleep, the change goes to the saved workspace; if the container started meanwhile, to it.
  const change = async (rel: string, inContainer: () => Promise<Response | null>, asleep: () => Promise<boolean | StoredRefusal>, missingIsOk = false) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await inContainer()
      if (response) {
        if (missingIsOk && response.status === 404) return
        if (!response.ok) await failed(response, rel)
        return
      }
      const stored = await asleep()
      if (typeof stored === 'string') throw new WorkspaceFileError(stored)
      if (stored) return
    }
    throw new Error(`The container for ${rel || '/'} kept starting and stopping`)
  }

  const upload = (rel: string, bytes: Uint8Array, mode?: number) =>
    change(
      rel,
      () => awake(`/files/${encodePath(rel)}/upload${modeQuery(mode)}`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> }),
      () => sleeping.write(rel, bytes, mode),
    )

  const files: StoreFileOps = {
    async list(dir) {
      const rel = dir ? normalizeWorkspacePath(dir) : ''
      const found = await info(rel)
      if (!found) throw new WorkspaceFileError('not-found')
      if (!Array.isArray(found)) throw new WorkspaceFileError('not-a-directory')
      return found.map((entry): FileEntry => ({ name: entry.name, path: entry.path, kind: entry.type }))
    },

    async stat(path) {
      const found = await info(normalizeWorkspacePath(path))
      if (!found) return null
      if (Array.isArray(found)) return { kind: 'directory', size: 0, mtimeMs: 0 }
      const stat: FileStat = { kind: found.type, size: found.size ?? 0, mtimeMs: found.modifiedAt ? Date.parse(found.modifiedAt) : 0 }
      return found.mode === undefined ? stat : { ...stat, mode: found.mode }
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

    async putDoc(path, bytes, options) {
      await upload(filePath(path), toBytes(bytes), options?.mode)
    },

    // A stream goes to a running container as it arrives, so a large upload is never whole in
    // memory. Asleep, the saved workspace hashes the whole file, so it is read first.
    async write(path, body, options) {
      const rel = filePath(path)
      if (body instanceof Uint8Array) {
        await upload(rel, body, options?.mode)
        return { size: body.byteLength }
      }
      let size = 0
      const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength
          controller.enqueue(chunk)
        },
      }))
      const response = await callContainer(`/files/${encodePath(rel)}/upload${modeQuery(options?.mode)}`, { method: 'POST', body: counted })
      if (response && !(response.status === 503 && response.headers.get(ASLEEP_HEADER) === '1')) {
        if (!response.ok) await failed(response, rel)
        return { size }
      }
      // The container went to sleep after taking (part of) the stream: it cannot be sent again.
      if (response) throw new Error(`The container stopped while ${rel} was being sent; try the upload again`)
      const bytes = await readUpTo(counted, MAX_ASLEEP_WRITE_BYTES, rel)
      await upload(rel, bytes, options?.mode)
      return { size: bytes.byteLength }
    },

    async delete(path, options) {
      const rel = normalizeWorkspacePath(path)
      if (rel === '') throw new WorkspaceFileError('invalid-path', 'The workspace root cannot be deleted')
      const refuseFolder = (isFolder: boolean) => {
        if (isFolder && !options?.recursive) throw new WorkspaceFileError('not-a-file', 'Path is a directory; delete it with recursive')
      }
      // The container deletes a named entry of a named kind (its file browser's delete), so the kind is asked first.
      const inContainer = async () => {
        const found = await awake(`/files/${encodePath(rel)}`)
        if (!found?.ok) return found
        const type = Array.isArray(await found.json()) ? 'directory' : 'file'
        refuseFolder(type === 'directory')
        return awake('/workspace/entries', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: `/workspace/${rel}`, type }),
        })
      }
      const asleep = async () => {
        const found = await sleeping.entry(rel)
        if (!found) return true
        refuseFolder(Array.isArray(found))
        return sleeping.remove(rel)
      }
      await change(rel, inContainer, asleep, true)
    },

    async mkdir(path) {
      const rel = path ? normalizeWorkspacePath(path) : ''
      if (!rel) return
      await change(rel, () => awake(`/files/${encodePath(rel)}/mkdir`, { method: 'POST' }), () => sleeping.mkdir(rel))
    },

    // The agent's object adds the bytes where the files are now: its container does one write at the
    // end of the file, and the saved workspace takes one append at a time. A line is never lost to
    // another writer of the same file.
    async append(path, bytes) {
      const rel = filePath(path)
      const appended = await sleeping.appendToFile(rel, toBytes(bytes))
    if (appended !== 'done') throw new WorkspaceFileError(appended)
    },

    async open(path): Promise<OpenFile> {
      const rel = normalizeWorkspacePath(path)
      const found = await info(rel)
      if (!found) throw new WorkspaceFileError('not-found')
      if (Array.isArray(found)) throw new WorkspaceFileError('not-a-file')
      // A small file once, whole; a large one by range, so opening it downloads nothing (OPEN_WHOLE_BYTES).
      let whole: Uint8Array | null = (found.size ?? 0) <= OPEN_WHOLE_BYTES ? await content(rel) : null
      let closed = false
      const assertOpen = () => {
        if (closed) throw new Error(`${rel} is closed`)
      }
      const sizeNow = async () => {
        const now = await info(rel)
        if (!now || Array.isArray(now)) throw new WorkspaceFileError('not-found')
        return now.size ?? 0
      }
      return {
        // Asked each time, as a local handle's size is: the file may have grown since it was opened.
        size: async () => {
          assertOpen()
          return sizeNow()
        },
        readAt: async (offset, length) => {
          assertOpen()
          // Past what was read at open, and the file grew: it is read by range from here on.
          if (whole && offset + length > whole.byteLength && (await sizeNow()) > whole.byteLength) whole = null
          if (whole) return whole.slice(offset, offset + length)
          if (length <= 0) return new Uint8Array()
          const stream = await bytesStream(rel, { start: offset, end: offset + length - 1 })
          if (!stream) throw new WorkspaceFileError('not-found')
          return readAll(stream)
        },
        stream: (range) => {
          assertOpen()
          closed = true
          if (!whole) return lazyStream(async () => (await bytesStream(rel, range)) ?? emptyStream())
          const all = whole
          whole = null
          return streamOf(slice(all, range))
        },
        close: async () => {
          closed = true
          whole = null
        },
      }
    },
  }
  return files
}
