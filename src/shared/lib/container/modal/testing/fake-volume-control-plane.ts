/**
 * An in-memory stand-in for the Modal control plane's version-2 volume RPCs
 * and the signed block URLs they hand out, so `ModalVolumeFiles` and
 * everything above it run their real protocol code in tests without Modal.
 *
 * It models what the probe against the real service showed: entries carry
 * full paths from the root; a listing of a file is that file; directories
 * exist only as parents of files; a path through a file is
 * FAILED_PRECONDITION "non-directory parent"; reading or writing over a
 * directory is FAILED_PRECONDITION "is a directory"; a refused overwrite is
 * INVALID_ARGUMENT "already exists"; a non-recursive removal of a directory
 * is FAILED_PRECONDITION "is not empty"; an absent path is NOT_FOUND. Block
 * bodies are served with their trailing zero bytes left off, as the real
 * service may do, so the client's padding is exercised.
 */
import { createHash } from 'crypto'
import type { ModalVolumeDeps } from '../modal-volume'
import { VOLUME_BLOCK_SIZE } from '../modal-volume'

const NOT_FOUND = 5
const INVALID_ARGUMENT = 3
const FAILED_PRECONDITION = 9
const FILE_TYPE_FILE = 1
const FILE_TYPE_DIRECTORY = 2

interface StoredFile {
  bytes: Uint8Array
  mode: number
  mtime: number
}

interface RawEntry {
  path: string
  type: number
  mtime: number
  size: number
}

function grpcError(code: number, details: string): Error {
  return Object.assign(new Error(`/ModalClient/Volume FAKE: ${details}`), { code, details })
}

function normalize(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '')
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest()
}

function trimTrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  return bytes.subarray(0, end)
}

export class FakeVolumeControlPlane {
  readonly volumeId = 'vo-fake'
  readonly files = new Map<string, StoredFile>()
  /** Uploaded block contents by their sha256 hex. */
  private readonly blobs = new Map<string, Uint8Array>()
  /** Signed URLs handed out for reads and writes. */
  private readonly getUrls = new Map<string, Uint8Array>()
  private readonly putUrls = new Map<string, string>()
  private readonly proofs = new Map<string, string>()
  private urlCounter = 0
  private clock = 1_700_000_000

  /** RPC calls seen, for assertions on protocol shape. */
  readonly calls: string[] = []

  /** The dependencies to hand `ModalVolumeFiles`. */
  get deps(): ModalVolumeDeps {
    return {
      controlPlane: () => this.controlPlane as unknown as ReturnType<ModalVolumeDeps['controlPlane']>,
      environmentName: () => 'test',
      fetch: (input, init) => this.fetch(String(input), init),
    }
  }

  private tick(): number {
    return this.clock++
  }

  private isDirectory(path: string): boolean {
    if (path === '') return true
    const prefix = `${path}/`
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  /** The nearest ancestor that is a file, when the path goes through one. */
  private fileAncestor(path: string): string | null {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('/')
      if (this.files.has(prefix)) return prefix
    }
    return null
  }

  private entryFor(path: string): RawEntry {
    const file = this.files.get(path)
    if (file) return { path, type: FILE_TYPE_FILE, mtime: file.mtime, size: file.bytes.length }
    let mtime = 0
    for (const [key, stored] of this.files) if (key.startsWith(`${path}/`)) mtime = Math.max(mtime, stored.mtime)
    return { path, type: FILE_TYPE_DIRECTORY, mtime, size: 0 }
  }

  private listEntries(path: string, recursive: boolean): RawEntry[] {
    if (path !== '' && this.files.has(path)) return [this.entryFor(path)]
    const through = this.fileAncestor(path)
    if (through) throw grpcError(FAILED_PRECONDITION, `path "/${path}" contains a non-directory parent: "/${through}"`)
    if (!this.isDirectory(path)) throw grpcError(NOT_FOUND, `path "/${path}" does not exist`)
    const prefix = path === '' ? '' : `${path}/`
    const seen = new Set<string>()
    const entries: RawEntry[] = []
    for (const key of [...this.files.keys()].sort()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length).split('/')
      const limit = recursive ? rest.length : 1
      for (let depth = 1; depth <= limit; depth++) {
        const candidate = prefix + rest.slice(0, depth).join('/')
        if (seen.has(candidate)) continue
        seen.add(candidate)
        entries.push(this.entryFor(candidate))
      }
    }
    return entries
  }

  private readonly controlPlane = {
    volumeGetOrCreate: async (request: { deploymentName?: string; objectCreationType?: number }) => {
      this.calls.push('volumeGetOrCreate')
      if (request.objectCreationType === 0 && request.deploymentName !== 'fake') {
        throw grpcError(NOT_FOUND, `Volume '${String(request.deploymentName)}' not found`)
      }
      return { volumeId: this.volumeId, version: 2, metadata: { version: 2, name: request.deploymentName ?? 'fake', creationInfo: undefined } }
    },
    volumeDelete: async () => {
      this.calls.push('volumeDelete')
    },
    volumeListFiles2: (request: { path?: string; recursive?: boolean }) => {
      this.calls.push('volumeListFiles2')
      const entries = this.listEntries(normalize(request.path ?? ''), request.recursive ?? false)
      return (async function* () {
        yield { entries }
      })()
    },
    volumeGetFile2: async (request: { path?: string; start?: number; len?: number }) => {
      this.calls.push('volumeGetFile2')
      const path = normalize(request.path ?? '')
      const file = this.files.get(path)
      if (!file) {
        if (this.isDirectory(path)) throw grpcError(FAILED_PRECONDITION, `path "/${path}" is a directory`)
        throw grpcError(NOT_FOUND, `path "/${path}" does not exist`)
      }
      const start = Math.min(request.start ?? 0, file.bytes.length)
      const requested = request.len && request.len > 0 ? request.len : file.bytes.length - start
      const len = Math.min(requested, file.bytes.length - start)
      const getUrls: string[] = []
      for (let pos = start; pos < start + len; ) {
        const blockEnd = Math.min(start + len, (Math.floor(pos / VOLUME_BLOCK_SIZE) + 1) * VOLUME_BLOCK_SIZE)
        const url = `mem://get/${this.urlCounter++}`
        this.getUrls.set(url, trimTrailingZeros(file.bytes.subarray(pos, blockEnd)))
        getUrls.push(url)
        pos = blockEnd
      }
      return { getUrls, size: file.bytes.length, start, len }
    },
    volumePutFiles2: async (request: {
      files?: Array<{ path?: string; size?: number; mode?: number; blocks?: Array<{ contentsSha256?: Uint8Array; putResponse?: Uint8Array }> }>
      disallowOverwriteExistingFiles?: boolean
    }) => {
      this.calls.push('volumePutFiles2')
      const missingBlocks: Array<{ fileIndex: number; blockIndex: number; putUrl: string }> = []
      const staged: Array<{ path: string; bytes: Uint8Array; mode: number }> = []
      ;(request.files ?? []).forEach((file, fileIndex) => {
        const path = normalize(file.path ?? '')
        if (this.isDirectory(path)) throw grpcError(FAILED_PRECONDITION, `path "/${path}" is a directory`)
        const through = this.fileAncestor(path)
        if (through) throw grpcError(FAILED_PRECONDITION, `path "/${path}" contains a non-directory parent: "/${through}"`)
        if (request.disallowOverwriteExistingFiles && this.files.has(path)) {
          throw grpcError(INVALID_ARGUMENT, `path "/${path}" already exists`)
        }
        const size = file.size ?? 0
        const bytes = new Uint8Array(size)
        ;(file.blocks ?? []).forEach((block, blockIndex) => {
          const hex = Buffer.from(block.contentsSha256 ?? []).toString('hex')
          let content = this.blobs.get(hex)
          if (!content && block.putResponse) {
            const proven = this.proofs.get(Buffer.from(block.putResponse).toString())
            if (proven === hex) content = this.blobs.get(hex)
          }
          if (!content) {
            const putUrl = `mem://put/${this.urlCounter++}`
            this.putUrls.set(putUrl, hex)
            missingBlocks.push({ fileIndex, blockIndex, putUrl })
            return
          }
          bytes.set(content, blockIndex * VOLUME_BLOCK_SIZE)
        })
        staged.push({ path, bytes, mode: file.mode ?? 0o644 })
      })
      if (missingBlocks.length > 0) return { missingBlocks }
      for (const file of staged) this.files.set(file.path, { bytes: file.bytes, mode: file.mode, mtime: this.tick() })
      return { missingBlocks: [] }
    },
    volumeRemoveFile2: async (request: { path?: string; recursive?: boolean }) => {
      this.calls.push('volumeRemoveFile2')
      const path = normalize(request.path ?? '')
      if (this.files.delete(path)) return {}
      if (!this.isDirectory(path)) throw grpcError(NOT_FOUND, `path "/${path}" does not exist`)
      if (!request.recursive) throw grpcError(FAILED_PRECONDITION, `directory "/${path}" is not empty`)
      for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key)
      return {}
    },
    volumeCopyFiles2: async (request: { srcPaths?: string[]; dstPath?: string; recursive?: boolean }) => {
      this.calls.push('volumeCopyFiles2')
      const dst = normalize(request.dstPath ?? '')
      for (const raw of request.srcPaths ?? []) {
        const src = normalize(raw)
        const file = this.files.get(src)
        if (file) {
          this.files.set(dst, { ...file, mtime: this.tick() })
          continue
        }
        if (!this.isDirectory(src)) throw grpcError(NOT_FOUND, `path "/${src}" does not exist`)
        if (!request.recursive) throw grpcError(FAILED_PRECONDITION, `path "/${src}" is a directory`)
        for (const [key, stored] of [...this.files]) {
          if (key.startsWith(`${src}/`)) this.files.set(`${dst}/${key.slice(src.length + 1)}`, { ...stored, mtime: this.tick() })
        }
      }
      return {}
    },
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (init?.method === 'PUT') {
      const expectedHex = this.putUrls.get(url)
      if (!expectedHex) return new Response('unknown upload url', { status: 403 })
      const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      if (sha256(body).toString('hex') !== expectedHex) return new Response('checksum mismatch', { status: 400 })
      this.blobs.set(expectedHex, body)
      const proof = `proof-${this.urlCounter++}`
      this.proofs.set(proof, expectedHex)
      return new Response(proof, { status: 200 })
    }
    const bytes = this.getUrls.get(url)
    if (!bytes) return new Response('unknown download url', { status: 403 })
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return new Response(copy, { status: 200 })
  }
}
