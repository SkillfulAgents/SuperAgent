/**
 * `StoreFileOps` over the container's workspace routes
 * (agent-container/src/workspace-fs.ts): the agent's files when its
 * workspace is inside its container. Written once, because the agent image
 * is ours: every runtime whose container runs that image reaches its
 * workspace the same way, through `fetch` to the container API.
 *
 * Paths are normalized here first, so a path that would leave the workspace
 * is refused before any request; the container checks again on its side.
 *
 * An open file is not a handle in the container: each `size` and `readAt`
 * is one request against the file as it is then, so a file that grows while
 * open is seen growing, as on a filesystem, and one that is replaced is read
 * as the new file.
 */
import type { ByteRange, FileEntry, FileStat, OpenFile, StoreFileOps, WriteOptions } from './types'
import { WorkspaceFileError, normalizeWorkspacePath, type WorkspaceFileErrorCode } from './workspace-path'

/** An HTTP request to the container API. */
export type ContainerFetch = (path: string, init?: RequestInit) => Promise<Response>

// Keep in sync with agent-container/src/workspace-fs.ts.
const PREFIX = '/workspace/fs'
const FILE_SIZE_HEADER = 'X-Workspace-File-Size'

const ERROR_CODES = new Set<WorkspaceFileErrorCode>([
  'already-exists',
  'invalid-path',
  'outside-workspace',
  'not-found',
  'not-a-file',
  'not-a-directory',
  'not-accessible',
  'not-empty',
])

type Query = Record<string, string | number | boolean | undefined>

function url(operation: string, rel: string, query: Query = {}): string {
  const params = new URLSearchParams({ path: rel })
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === false) continue
    params.set(key, value === true ? '1' : String(value))
  }
  return `${PREFIX}/${operation}?${params}`
}

/** The contract's error for a refusal from the container, or a plain error for anything else. */
async function failed(response: Response, operation: string): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  const code = body?.error?.code
  if (code && ERROR_CODES.has(code as WorkspaceFileErrorCode)) {
    throw new WorkspaceFileError(code as WorkspaceFileErrorCode, body?.error?.message)
  }
  throw new Error(`Container workspace ${operation} failed: ${response.status} ${body?.error?.message ?? ''}`.trim())
}

const toBytes = (bytes: Uint8Array | string): Uint8Array =>
  typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes

/** A stream body needs `duplex: 'half'` on Node's fetch. */
function bodyInit(method: string, body: ReadableStream<Uint8Array> | Uint8Array): RequestInit {
  return body instanceof Uint8Array
    ? { method, body: body as Uint8Array<ArrayBuffer> }
    : ({ method, body, duplex: 'half' } as RequestInit)
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() })
}

export function createContainerFileOps(fetch: ContainerFetch): StoreFileOps {
  const call = async (operation: string, target: string, init?: RequestInit): Promise<Response> => {
    const response = await fetch(target, init)
    if (!response.ok) return failed(response, operation)
    return response
  }
  const json = async <T>(operation: string, target: string, init?: RequestInit): Promise<T> =>
    (await (await call(operation, target, init)).json()) as T

  const statOf = (rel: string) => json<FileStat | null>('stat', url('stat', rel))

  /** One read of the file: its size at the open and the bytes. */
  const read = async (
    rel: string,
    query: Query,
    signal?: AbortSignal,
  ): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> => {
    const response = await call('read', url('read', rel, query), signal ? { signal } : undefined)
    const size = Number(response.headers.get(FILE_SIZE_HEADER) ?? NaN)
    if (!Number.isFinite(size)) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`Container workspace read of ${rel} did not report the file size`)
    }
    return { size, stream: response.body ?? emptyStream() }
  }

  const bytesOf = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
    new Uint8Array(await new Response(stream).arrayBuffer())

  const files: StoreFileOps = {
    list: async (dir) => json<FileEntry[]>('list', url('list', normalizeWorkspacePath(dir))),

    stat: async (path) => statOf(normalizeWorkspacePath(path)),

    resolve: async (path) => (await json<{ path: string | null }>('resolve', url('resolve', normalizeWorkspacePath(path)))).path,

    read: async (path, range?: ByteRange) =>
      (await read(normalizeWorkspacePath(path), range ? { start: range.start, end: range.end } : {})).stream,

    readSized: (path, options) => read(normalizeWorkspacePath(path), { confined: options?.confined }),

    getDoc: async (path) => {
      try {
        return await bytesOf((await read(normalizeWorkspacePath(path), {})).stream)
      } catch (error) {
        if (error instanceof WorkspaceFileError && error.code === 'not-found') return null
        throw error
      }
    },

    // A document is flushed before the write returns, as `putDoc` always is.
    putDoc: async (path, bytes, options?: WriteOptions) => {
      await files.write(path, toBytes(bytes), { ...options, flush: true })
    },

    write: async (path, body, options?: WriteOptions) => {
      let rel: string
      try {
        rel = normalizeWorkspacePath(path)
      } catch (error) {
        // A refused destination must not leave the caller's source open.
        if (!(body instanceof Uint8Array)) await body.cancel().catch(() => {})
        throw error
      }
      const query: Query = {
        mode: options?.mode,
        flush: options?.flush,
        confined: options?.confined,
        overwrite: options?.overwrite === undefined ? undefined : options.overwrite ? 1 : 0,
      }
      return json<{ size: number }>('write', url('file', rel, query), bodyInit('PUT', body))
    },

    delete: async (path, options) => {
      await call('delete', url('entry', normalizeWorkspacePath(path), { recursive: options?.recursive, confined: options?.confined }), {
        method: 'DELETE',
      })
    },

    mkdir: async (path) => {
      await call('mkdir', url('mkdir', normalizeWorkspacePath(path)), { method: 'POST' })
    },

    // One request carries the whole payload, so the container writes it as one append.
    append: async (path, bytes) => {
      await call('append', url('append', normalizeWorkspacePath(path)), bodyInit('POST', toBytes(bytes)))
    },

    open: async (path, options) => {
      const rel = normalizeWorkspacePath(path)
      const fileStat = async () => {
        const stat = await statOf(rel)
        if (!stat) throw new WorkspaceFileError('not-found')
        if (stat.kind !== 'file') throw new WorkspaceFileError('not-a-file')
        return stat
      }
      await fileStat()
      const confined = options?.confined
      const file: OpenFile = {
        size: async () => (await fileStat()).size,
        readAt: async (offset, length, signal) => {
          signal?.throwIfAborted()
          if (length <= 0) return new Uint8Array()
          const { stream } = await read(rel, { start: offset, end: offset + length - 1, lenient: true, confined }, signal)
          return bytesOf(stream)
        },
        // Fetched when first pulled: `stream` itself does no I/O.
        stream: (range) => {
          let source: ReadableStreamDefaultReader<Uint8Array> | undefined
          return new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              source ??= (
                await read(rel, range ? { start: range.start, end: range.end, lenient: true, confined } : { confined })
              ).stream.getReader()
              const { done, value } = await source.read()
              if (done) controller.close()
              else controller.enqueue(value)
            },
            cancel: async (reason) => {
              await source?.cancel(reason)
            },
          })
        },
        close: async () => {},
      }
      return file
    },
  }
  return files
}
