/**
 * Files in a Modal volume, read and written from this process: no sandbox is
 * involved, so a stopped agent's workspace is as reachable as a running one's.
 *
 * The `modal` package wraps volumes only as far as mounting them. The volume
 * RPCs themselves are in the gRPC client it bundles, and this module speaks
 * the version-2 volume protocol over them the way Modal's Python client does:
 *
 * - a listing is a server stream of entries with full paths from the volume root;
 * - a read is one RPC that answers with a signed URL per 8 MiB block of the
 *   requested range, each block downloaded over plain HTTPS, with trailing
 *   zero bytes left off the body for the client to restore;
 * - a write hashes each 8 MiB block (again with trailing zeros trimmed), asks
 *   the volume which blocks it lacks, PUTs those to the signed URLs it
 *   answers with, and repeats the request with each PUT's response body as
 *   proof, which also makes an upload of unchanged content a no-op.
 *
 * Directories exist only as the parents of files: there is no mkdir.
 */
import { createHash } from 'crypto'
import {
  GRPC_ALREADY_EXISTS,
  GRPC_FAILED_PRECONDITION,
  GRPC_INVALID_ARGUMENT,
  GRPC_NOT_FOUND,
  grpcDetails,
  grpcStatusCode,
  modalControlPlane,
  modalEnvironmentName,
} from './modal-client'

export const VOLUME_BLOCK_SIZE = 8 * 1024 * 1024

const OBJECT_CREATION_TYPE_UNSPECIFIED = 0
const OBJECT_CREATION_TYPE_CREATE_IF_MISSING = 1
const VOLUME_FS_VERSION_V2 = 2
const FILE_TYPE_FILE = 1
const FILE_TYPE_DIRECTORY = 2

export type VolumeEntryKind = 'file' | 'directory' | 'other'

export interface VolumeEntry {
  /** Path from the volume root, no leading slash. */
  path: string
  kind: VolumeEntryKind
  size: number
  mtimeMs: number
}

export type ModalVolumeErrorCode =
  | 'not-found'
  | 'not-a-directory'
  | 'is-a-directory'
  | 'already-exists'
  | 'directory-not-empty'

export class ModalVolumeError extends Error {
  constructor(
    readonly code: ModalVolumeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ModalVolumeError'
  }
}

/** Translate a volume RPC failure into the contract's error, or rethrow it. */
export function translateVolumeError(error: unknown): never {
  const code = grpcStatusCode(error)
  const details = grpcDetails(error)
  if (code === GRPC_NOT_FOUND) throw new ModalVolumeError('not-found', details)
  if (code === GRPC_FAILED_PRECONDITION) {
    if (/non-directory parent/i.test(details)) throw new ModalVolumeError('not-a-directory', details)
    if (/is a directory/i.test(details)) throw new ModalVolumeError('is-a-directory', details)
    if (/is not empty/i.test(details)) throw new ModalVolumeError('directory-not-empty', details)
  }
  if ((code === GRPC_INVALID_ARGUMENT || code === GRPC_ALREADY_EXISTS) && /already exists/i.test(details)) {
    throw new ModalVolumeError('already-exists', details)
  }
  throw error
}

export interface BlockPlan {
  /** Offset of the block in the file. */
  start: number
  /** End of the block's content, trailing zero bytes excluded. */
  end: number
  sha256: Buffer
}

/** The 8 MiB blocks of a file as the volume hashes them: trailing zero bytes are not part of a block. */
export function planBlocks(bytes: Uint8Array): BlockPlan[] {
  const blocks: BlockPlan[] = []
  for (let start = 0; start < bytes.length; start += VOLUME_BLOCK_SIZE) {
    let end = Math.min(bytes.length, start + VOLUME_BLOCK_SIZE)
    while (end > start && bytes[end - 1] === 0) end--
    blocks.push({ start, end, sha256: createHash('sha256').update(bytes.subarray(start, end)).digest() })
  }
  return blocks
}

/** How many bytes of a byte range fall into each of its block-aligned blocks. */
export function expectedBlockLengths(start: number, length: number, blockCount: number): number[] {
  const lengths: number[] = []
  let pos = start
  for (let idx = 0; idx < blockCount; idx++) {
    const blockEnd = Math.min(start + length, (Math.floor(start / VOLUME_BLOCK_SIZE) + idx + 1) * VOLUME_BLOCK_SIZE)
    lengths.push(Math.max(0, blockEnd - pos))
    pos = blockEnd
  }
  return lengths
}

/** A closed byte range, both ends inclusive. */
export interface VolumeByteRange {
  start: number
  end: number
}

export interface PutOptions {
  /** Unix permission bits; 0o644 when absent. */
  mode?: number
  /** Refuse to replace an existing file (`already-exists`). Default: replace it. */
  overwrite?: boolean
}

type ControlPlane = ReturnType<typeof modalControlPlane>

/** What the client needs from its surroundings; injected so tests run without Modal. */
export interface ModalVolumeDeps {
  controlPlane: () => ControlPlane
  environmentName: () => string
  fetch: typeof fetch
}

const defaultDeps: ModalVolumeDeps = {
  controlPlane: modalControlPlane,
  environmentName: modalEnvironmentName,
  fetch: (...args) => globalThis.fetch(...args),
}

const BLOCK_HTTP_ATTEMPTS = 3
const PUT_CONCURRENCY = 4

async function withAttempts<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let n = 0; n < BLOCK_HTTP_ATTEMPTS; n++) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** n))
    }
  }
  throw lastError
}

function toEntry(raw: { path: string; type: number; mtime: number; size: number }): VolumeEntry {
  return {
    path: raw.path.replace(/^\/+/, ''),
    kind: raw.type === FILE_TYPE_FILE ? 'file' : raw.type === FILE_TYPE_DIRECTORY ? 'directory' : 'other',
    size: raw.size,
    mtimeMs: raw.mtime * 1000,
  }
}

export class ModalVolumeFiles {
  constructor(
    readonly volumeId: string,
    readonly name: string,
    private readonly deps: ModalVolumeDeps = defaultDeps,
  ) {}

  /** The named volume, created as a version-2 volume when it does not exist. */
  static async ensure(name: string, deps: ModalVolumeDeps = defaultDeps): Promise<ModalVolumeFiles> {
    const response = await deps.controlPlane().volumeGetOrCreate({
      deploymentName: name,
      environmentName: deps.environmentName(),
      objectCreationType: OBJECT_CREATION_TYPE_CREATE_IF_MISSING,
      version: VOLUME_FS_VERSION_V2,
    })
    const version = response.metadata?.version
    if (version !== VOLUME_FS_VERSION_V2) {
      throw new Error(`Modal volume ${name} is a version ${String(version)} volume; the file RPCs used here need version 2`)
    }
    return new ModalVolumeFiles(response.volumeId, name, deps)
  }

  /** Delete the named volume and everything in it. An absent volume is a no-op. */
  static async remove(name: string, deps: ModalVolumeDeps = defaultDeps): Promise<void> {
    let volumeId: string
    try {
      const response = await deps.controlPlane().volumeGetOrCreate({
        deploymentName: name,
        environmentName: deps.environmentName(),
        objectCreationType: OBJECT_CREATION_TYPE_UNSPECIFIED,
      })
      volumeId = response.volumeId
    } catch (error) {
      if (grpcStatusCode(error) === GRPC_NOT_FOUND) return
      throw error
    }
    await deps.controlPlane().volumeDelete({ volumeId })
  }

  /**
   * The entries under a directory (`''` is the root), or the one entry of a
   * file when `path` names a file. `not-found` for an absent path,
   * `not-a-directory` when a file stands where a parent directory should.
   */
  async list(path: string, recursive = false): Promise<VolumeEntry[]> {
    const entries: VolumeEntry[] = []
    try {
      for await (const batch of this.deps.controlPlane().volumeListFiles2({ volumeId: this.volumeId, path, recursive })) {
        for (const entry of batch.entries) entries.push(toEntry(entry))
      }
    } catch (error) {
      translateVolumeError(error)
    }
    return entries
  }

  /**
   * What is at a path, or null when nothing is. A directory's size and mtime
   * are not reported by the volume and read as zero.
   */
  async entry(path: string): Promise<VolumeEntry | null> {
    if (path === '') return { path: '', kind: 'directory', size: 0, mtimeMs: 0 }
    let listed: VolumeEntry[]
    try {
      listed = await this.list(path)
    } catch (error) {
      if (error instanceof ModalVolumeError && (error.code === 'not-found' || error.code === 'not-a-directory')) return null
      throw error
    }
    // Listing a file answers with that file; listing a directory answers with its children.
    const self = listed.find((candidate) => candidate.path === path)
    return self ?? { path, kind: 'directory', size: 0, mtimeMs: 0 }
  }

  /**
   * A file's bytes as a stream of blocks, optionally one byte range. The
   * volume answers `not-found` for an absent path and `is-a-directory` for a
   * directory before any block is fetched.
   */
  async readStream(path: string, range?: VolumeByteRange): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
    let response: Awaited<ReturnType<ControlPlane['volumeGetFile2']>>
    try {
      // Without the newer `clientPadsBlocks` request flag the volume sends
      // each block whole; `fetchBlock` pads anyway, so either server answer works.
      response = await this.deps.controlPlane().volumeGetFile2({
        volumeId: this.volumeId,
        path,
        start: range?.start ?? 0,
        len: range ? range.end - range.start + 1 : 0,
      })
    } catch (error) {
      translateVolumeError(error)
    }
    const urls = response.getUrls
    const lengths = expectedBlockLengths(response.start, response.len, urls.length)
    let next = 0
    const fetchBlock = (url: string, expected: number) => this.fetchBlock(url, expected)
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (next >= urls.length) {
          controller.close()
          return
        }
        const idx = next++
        controller.enqueue(await fetchBlock(urls[idx], lengths[idx]))
      },
    })
    return { stream, size: response.size }
  }

  /** A whole file, or one byte range of it. */
  async read(path: string, range?: VolumeByteRange): Promise<Uint8Array> {
    const { stream } = await this.readStream(path, range)
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }

  private async fetchBlock(url: string, expectedLength: number): Promise<Uint8Array> {
    return withAttempts(async () => {
      const response = await this.deps.fetch(url)
      if (!response.ok) throw new Error(`Modal volume block download failed with status ${response.status}`)
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.length > expectedLength) {
        throw new Error(`Modal volume block is ${body.length} bytes, longer than the expected ${expectedLength}`)
      }
      if (body.length === expectedLength) return body
      // Trailing zero bytes are left off the body; restore them.
      const padded = new Uint8Array(expectedLength)
      padded.set(body)
      return padded
    })
  }

  /** Write a whole file, creating its parent directories. */
  async put(path: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
    const blocks = planBlocks(bytes)
    const putResponses = new Map<string, Uint8Array>()
    // Two rounds at most: the first learns which blocks are missing, the
    // second hands in the proofs of their upload.
    for (let round = 0; round < 2; round++) {
      let response: Awaited<ReturnType<ControlPlane['volumePutFiles2']>>
      try {
        response = await this.deps.controlPlane().volumePutFiles2({
          volumeId: this.volumeId,
          files: [
            {
              path,
              size: bytes.length,
              mode: options.mode ?? 0o644,
              blocks: blocks.map((block) => ({
                contentsSha256: block.sha256,
                putResponse: putResponses.get(block.sha256.toString('hex')),
              })),
            },
          ],
          disallowOverwriteExistingFiles: options.overwrite === false,
        })
      } catch (error) {
        translateVolumeError(error)
      }
      if (response.missingBlocks.length === 0) return
      const missing = [...response.missingBlocks]
      const workers = Array.from({ length: Math.min(PUT_CONCURRENCY, missing.length) }, async () => {
        for (let item = missing.shift(); item; item = missing.shift()) {
          const block = blocks[item.blockIndex]
          if (!block) throw new Error(`Modal volume asked for block ${item.blockIndex} of a ${blocks.length}-block file`)
          const proof = await this.putBlock(item.putUrl, bytes.subarray(block.start, block.end))
          putResponses.set(block.sha256.toString('hex'), proof)
        }
      })
      await Promise.all(workers)
    }
    throw new Error(`Modal volume upload of ${path} did not complete after uploading its missing blocks`)
  }

  private async putBlock(url: string, body: Uint8Array): Promise<Uint8Array> {
    // A view into the file's buffer is not a request body to the fetch
    // typings; a block-sized copy is, and is at most 8 MiB.
    const payload = new Uint8Array(body.byteLength)
    payload.set(body)
    return withAttempts(async () => {
      const response = await this.deps.fetch(url, { method: 'PUT', body: payload })
      if (!response.ok) throw new Error(`Modal volume block upload failed with status ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    })
  }

  /** Remove a file, or a directory tree with `recursive`. `not-found` when nothing is there. */
  async remove(path: string, recursive = false): Promise<void> {
    try {
      await this.deps.controlPlane().volumeRemoveFile2({ volumeId: this.volumeId, path, recursive })
    } catch (error) {
      translateVolumeError(error)
    }
  }

  /** Copy a file (or a tree with `recursive`) to another path, with `cp` semantics. */
  async copy(from: string, to: string, recursive = false): Promise<void> {
    try {
      await this.deps.controlPlane().volumeCopyFiles2({ volumeId: this.volumeId, srcPaths: [from], dstPath: to, recursive })
    } catch (error) {
      translateVolumeError(error)
    }
  }
}
