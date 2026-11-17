/**
 * Chunked uploads, for every process that serves a tenant. AppState holds one
 * manifest per upload and decides everything; a byte store only keeps bytes
 * (`chunked-upload-bytes.ts`). docs/app-state.md has the design.
 *
 * An upload is one attempt: its chunks in order, one write at a time. Anything
 * else is refused, and any failure ends the attempt, so a client that wants to
 * try again sends the file again under a new upload id.
 *
 * The commit of the last chunk moves the upload to `finalizing` in one
 * compare-and-set, and the request whose commit that was runs `finish`. Nobody
 * else ever does, so a crash during `finish` is not recovered. A new attempt
 * after an uncertain result may repeat an import that already succeeded.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import {
  appState,
  defineNamespace,
  digestKeyPart,
  reduceRecord,
  type RecordChange,
  type StateKey,
} from '@shared/lib/app-state'
import { background } from '@shared/lib/background'
import { PassTask, taskManager } from '@shared/lib/background-work'
import { captureException } from '@shared/lib/error-reporting'
import { LOCAL_CHUNKS_DIR, UPLOAD_BYTES_PREFIX, uploadByteStore, type UploadByteStore } from './chunked-upload-bytes'
import {
  MAX_UPLOAD_CHUNKS,
  uploadIdSchema,
  uploadManifestSchema,
  type CommittedChunk,
  type UploadManifest,
} from './chunked-upload-schema'
import { ensureDirectory, getTempUploadsDir, removeDirectory } from './file-storage'

// Workspace chat/file uploads. Streaming keeps RAM O(chunk); this caps disk.
export const MAX_UPLOAD_TOTAL_SIZE = 2 * 1024 * 1024 * 1024

/**
 * A manifest's life after its last write, judged by the backend. It is also the
 * deadline of a write in flight and of a crashed `finish`: past it the manifest
 * is gone, a late commit is refused, and the sweep removes the bytes.
 */
export const UPLOAD_IDLE_EXPIRY_MS = 60 * 60 * 1000
/** Below the temp uploads dir: files `toFile` wrote for a caller. */
const ASSEMBLED_DIR = 'assembled'
/** How old bytes nothing refers to must be before the sweep removes them. */
const STALE_UPLOAD_AGE_MS = 60 * 60 * 1000
const STALE_UPLOAD_SWEEP_EVERY_MS = 30 * 60 * 1000

const uploads = defineNamespace({
  name: 'upload',
  consistency: 'strong',
  schema: uploadManifestSchema,
  expiry: { ttlMs: UPLOAD_IDLE_EXPIRY_MS, onUpdate: 'reset' },
})

export function formatUploadTooLargeMessage(size: number, maxBytes: number): string {
  return `File too large (${(size / 1024 / 1024).toFixed(1)}MB, max ${maxBytes / 1024 / 1024}MB)`
}

// Throw from storeUploadChunk so routes can map to HTTP 413 without reading bytes.
export class UploadTooLargeError extends Error {
  readonly size: number
  readonly maxBytes: number

  constructor(size: number, maxBytes: number) {
    super(formatUploadTooLargeMessage(size, maxBytes))
    this.name = 'UploadTooLargeError'
    this.size = size
    this.maxBytes = maxBytes
  }
}

/** The chunk does not fit the upload as stored: routes answer 409. Its bytes were not kept. */
export class UploadConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadConflictError'
  }
}

/**
 * The upload's side effect may have happened, and what failed came after it. A
 * consumer throws this rather than let the failure read as "nothing happened".
 */
export class UploadOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('The upload may have taken effect, but its result is unknown. Check before sending it again.', { cause })
    this.name = 'UploadOutcomeUnknownError'
  }
}

export interface StoreChunkInput {
  /** The authenticated user. Their upload ids and bytes are their own. */
  ownerId: string
  uploadId: string
  /** What the upload is for, such as `agent:{slug}`. */
  target: string
  chunkIndex: number
  totalChunks: number
  chunk: Buffer
  maxTotalBytes: number
}

export interface AssembledUpload {
  /** The whole upload's size in bytes. */
  readonly size: number
  /**
   * The chunks in order, each opened only when the one before it has been read
   * through. It closes only after the last chunk proved its size: a chunk that
   * is missing, unreadable or another size errors it, so a consumer cannot take
   * part of an upload for the whole. Read it before `finish` returns: the chunks
   * go after that.
   */
  stream(): ReadableStream<Uint8Array>
  /**
   * The whole upload as a file on this machine, for a consumer that needs a
   * path. Written on the first call, and removed after `finish` unless the
   * consumer moved it. Nothing is written unless someone asks.
   */
  toFile(): Promise<string>
}

/**
 * Consumes the upload, once. The upload ends with it whatever happens, and its
 * bytes go, so a throw is not retried: throw `UploadOutcomeUnknownError` when
 * the side effect may have happened.
 */
export type FinishUpload<T> = (assembled: AssembledUpload) => Promise<T>

export type StoreChunkResult<T> =
  | { status: 'received' }
  /** This was the last chunk, and this is what `finish` returned. */
  | { status: 'finished'; result: T }

/** One try at storing one chunk. */
interface ChunkAttempt {
  key: StateKey<UploadManifest, 'strong'>
  ownerPart: string
  uploadId: string
  target: string
  totalChunks: number
  maxBytes: number
  index: number
  size: number
  attemptId: string
}

const START_AGAIN = 'Start a new upload to send the file again.'
const NOT_STARTED = `This upload has not started, or it has expired. ${START_AGAIN}`
const OUT_OF_ORDER = `This chunk is out of order for this upload. ${START_AGAIN}`
const WRITE_IN_FLIGHT = `Another chunk of this upload is still being written. ${START_AGAIN}`
const DIFFERENT_DETAILS = `This upload was started with different details. ${START_AGAIN}`
const ALREADY_ENDED = 'This upload has already ended, perhaps successfully. Check its result before starting a new upload.'
const ALREADY_FINALIZING = 'This upload is already being processed, or stopped while it was. Check its result before starting a new upload.'
const TOO_LATE = `This chunk arrived after its upload moved on. ${START_AGAIN}`

function ignoreCleanupError(err: unknown, op: string, extra?: Record<string, unknown>): void {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
  console.warn(`[chunked-upload] ${op} failed:`, err)
  captureException(err, { tags: { area: 'chunked-upload', op }, extra })
}

/** The owner's part of a key or a path: fixed length and safe in both. */
function ownerPartOf(ownerId: string): string {
  return digestKeyPart(ownerId)
}

function manifestKey(ownerPart: string, uploadId: string): StateKey<UploadManifest, 'strong'> {
  return uploads.key(ownerPart, uploadId)
}

/** An upload's manifest key, for tests. Only this module writes it. */
export function uploadManifestKey(ownerId: string, uploadId: string): StateKey<UploadManifest, 'strong'> {
  return manifestKey(ownerPartOf(ownerId), uploadId.toLowerCase())
}

function bytesKey(ownerPart: string, uploadId: string, attemptId: string): string {
  return `${UPLOAD_BYTES_PREFIX}${ownerPart}/${uploadId}/${attemptId}`
}

function describeAttempt(input: StoreChunkInput): ChunkAttempt {
  const { chunkIndex, totalChunks, maxTotalBytes } = input
  const uploadId = uploadIdSchema.parse(input.uploadId).toLowerCase()
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_UPLOAD_CHUNKS) {
    throw new RangeError(`An upload has 1 to ${MAX_UPLOAD_CHUNKS} chunks`)
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new RangeError('The chunk index is outside the upload')
  }
  const ownerPart = ownerPartOf(input.ownerId)
  return {
    key: manifestKey(ownerPart, uploadId),
    ownerPart,
    uploadId,
    target: input.target,
    totalChunks,
    maxBytes: maxTotalBytes,
    index: chunkIndex,
    size: input.chunk.byteLength,
    attemptId: `${Date.now()}-${randomUUID()}`,
  }
}

type Reserved =
  | { kind: 'write' }
  | { kind: 'refused'; message: string }
  | { kind: 'too_large'; size: number; committed: string[] }

type Committed =
  | { kind: 'received' }
  /** This commit moved the upload to `finalizing`, so this request runs `finish`. */
  | { kind: 'claimed'; chunks: CommittedChunk[] }
  | { kind: 'refused' }

/**
 * Takes the one write slot, for exactly the next chunk. A refusal changes
 * nothing: whoever holds the slot goes on.
 */
function reserve(manifest: UploadManifest | null, attempt: ChunkAttempt): RecordChange<UploadManifest, Reserved> {
  const refused = (message: string): RecordChange<UploadManifest, Reserved> => ({ result: { kind: 'refused', message } })
  if (!manifest && attempt.index !== 0) return refused(NOT_STARTED)
  if (manifest?.state === 'ended') return refused(ALREADY_ENDED)
  if (manifest?.state === 'finalizing') return refused(ALREADY_FINALIZING)
  if (manifest && (manifest.target !== attempt.target || manifest.totalChunks !== attempt.totalChunks || manifest.maxBytes !== attempt.maxBytes)) {
    return refused(DIFFERENT_DETAILS)
  }
  if (manifest?.writing) return refused(WRITE_IN_FLIGHT)
  const chunks = manifest?.chunks ?? []
  if (attempt.index !== chunks.length) return refused(OUT_OF_ORDER)

  const size = chunks.reduce((total, chunk) => total + chunk.size, attempt.size)
  if (size > attempt.maxBytes) {
    return { result: { kind: 'too_large', size, committed: chunks.map((chunk) => chunk.attemptId) }, value: { state: 'ended' } }
  }
  const { target, totalChunks, maxBytes } = attempt
  return { result: { kind: 'write' }, value: { target, totalChunks, maxBytes, state: 'receiving', chunks, writing: attempt.attemptId } }
}

/**
 * Commits bytes that were written, while this attempt still holds the slot. The
 * commit of the last chunk also moves the upload to `finalizing`: that is the
 * claim, one write, so one request and no other runs `finish`.
 */
function commit(manifest: UploadManifest | null, attempt: ChunkAttempt): RecordChange<UploadManifest, Committed> {
  if (manifest?.state !== 'receiving' || manifest.writing !== attempt.attemptId) return { result: { kind: 'refused' } }
  const { target, totalChunks, maxBytes } = manifest
  const chunks = [...manifest.chunks, { attemptId: attempt.attemptId, size: attempt.size }]
  if (chunks.length === totalChunks) {
    return { result: { kind: 'claimed', chunks }, value: { target, totalChunks, maxBytes, state: 'finalizing', chunks } }
  }
  return { result: { kind: 'received' }, value: { ...manifest, chunks, writing: null } }
}

/**
 * Ends the upload this attempt is part of, and says which chunks were committed.
 * Only while the manifest still names the attempt: one that has expired and been
 * started again under the same id is another upload.
 */
function end(manifest: UploadManifest | null, attemptId: string): RecordChange<UploadManifest, string[]> {
  if (manifest?.state !== 'receiving' && manifest?.state !== 'finalizing') return { result: [] }
  const committed = manifest.chunks.map((chunk) => chunk.attemptId)
  const named = committed.includes(attemptId) || (manifest.state === 'receiving' && manifest.writing === attemptId)
  return named ? { result: committed, value: { state: 'ended' } } : { result: [] }
}

/** Deletes bytes nothing refers to. One that stays is the sweep's to remove. */
async function deleteBytes(store: UploadByteStore, attempt: ChunkAttempt, attemptIds: string[]): Promise<void> {
  await Promise.all(attemptIds.map(async (attemptId) => {
    const key = bytesKey(attempt.ownerPart, attempt.uploadId, attemptId)
    try {
      await store.delete(key)
    } catch (err) {
      ignoreCleanupError(err, 'delete-chunk', { key })
    }
  }))
}

/**
 * Ends the attempt and deletes its bytes, plus `unneeded`, which nothing can need
 * whatever AppState says. Never throws: if AppState cannot be reached, the
 * manifest expires and the sweep removes the rest.
 */
async function endAttempt(store: UploadByteStore, attempt: ChunkAttempt, unneeded: string[] = []): Promise<void> {
  let known: string[] = []
  try {
    known = [...await reduceRecord(attempt.key, (manifest) => end(manifest, attempt.attemptId)), attempt.attemptId]
  } catch (err) {
    ignoreCleanupError(err, 'end-attempt', { uploadId: attempt.uploadId })
  }
  await deleteBytes(store, attempt, [...new Set([...known, ...unneeded])])
}

/**
 * A change to the manifest, with no retry and no read-back. A failure may be a
 * write that landed with its answer lost, even the claim. The request does not
 * know it won, so it does not go on: it ends the attempt and fails.
 */
async function changeManifest<R>(
  store: UploadByteStore,
  attempt: ChunkAttempt,
  change: (manifest: UploadManifest | null) => RecordChange<UploadManifest, R>,
): Promise<R> {
  try {
    return await reduceRecord(attempt.key, change)
  } catch (error) {
    await endAttempt(store, attempt)
    throw error
  }
}

/**
 * The committed chunks one after another, read only as they are asked for
 * (`highWaterMark: 0`), so the next chunk stays closed until the one before it
 * has been read through and proved the size the manifest says.
 */
function readChunksInOrder(store: UploadByteStore, attempt: ChunkAttempt, chunks: CommittedChunk[]): ReadableStream<Uint8Array> {
  let index = 0
  let open: ReadableStreamDefaultReader<Uint8Array> | null = null
  let readOfChunk = 0
  let cancelled = false
  const closeOpen = async (reason: unknown): Promise<void> => {
    const reader = open
    open = null
    await reader?.cancel(reason).catch(() => undefined)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const chunk = chunks[index]
          if (!chunk) {
            controller.close()
            return
          }
          if (!open) {
            const source = await store.stream(bytesKey(attempt.ownerPart, attempt.uploadId, chunk.attemptId))
            if (cancelled) {
              await source?.cancel().catch(() => undefined)
              return
            }
            if (!source) throw new Error(`Upload chunk ${index} is missing`)
            open = source.getReader()
            readOfChunk = 0
          }
          const { done, value } = await open.read()
          if (done) {
            if (readOfChunk !== chunk.size) throw new Error(`Upload chunk ${index} is ${readOfChunk} bytes, its manifest says ${chunk.size}`)
            open = null
            index++
            continue
          }
          readOfChunk += value.byteLength
          if (readOfChunk > chunk.size) throw new Error(`Upload chunk ${index} is over the ${chunk.size} bytes its manifest says`)
          controller.enqueue(value)
          return
        }
      } catch (error) {
        await closeOpen(error)
        throw error
      }
    },
    cancel(reason) {
      cancelled = true
      return closeOpen(reason)
    },
  }, { highWaterMark: 0 })
}

/** What `finish` gets, and how to remove the file it may have asked for. */
function openAssembled(store: UploadByteStore, attempt: ChunkAttempt, chunks: CommittedChunk[]) {
  const filePath = path.join(getTempUploadsDir(), ASSEMBLED_DIR, `${attempt.ownerPart}.${attempt.uploadId}.${attempt.attemptId}`)
  const stream = () => readChunksInOrder(store, attempt, chunks)
  const spool = async (): Promise<string> => {
    await ensureDirectory(path.dirname(filePath))
    await pipeline(Readable.fromWeb(stream() as NodeReadableStream), fs.createWriteStream(filePath))
    return filePath
  }
  let spooled: Promise<string> | null = null
  const assembled: AssembledUpload = {
    size: chunks.reduce((total, chunk) => total + chunk.size, 0),
    stream,
    toFile: () => (spooled ??= spool()),
  }
  return {
    assembled,
    removeFile: async () => {
      if (!spooled) return
      await spooled.catch(() => undefined)
      await fs.promises.unlink(filePath).catch((err: unknown) => ignoreCleanupError(err, 'unlink-assembled', { filePath }))
    },
  }
}

/**
 * Stores one chunk of an upload. Chunk 0 creates the manifest, and every other
 * chunk must be exactly the next one, with no write in flight. `finish` runs in
 * the request that commits the last chunk.
 *
 * @throws UploadTooLargeError when the upload goes over `maxTotalBytes`, which ends it
 * @throws UploadConflictError when this chunk is refused
 */
export async function storeUploadChunk<T>(input: StoreChunkInput, finish: FinishUpload<T>): Promise<StoreChunkResult<T>> {
  const store = uploadByteStore()
  const attempt = describeAttempt(input)

  const reserved = await changeManifest(store, attempt, (manifest) => reserve(manifest, attempt))
  if (reserved.kind === 'refused') throw new UploadConflictError(reserved.message)
  if (reserved.kind === 'too_large') {
    await deleteBytes(store, attempt, reserved.committed)
    throw new UploadTooLargeError(reserved.size, attempt.maxBytes)
  }

  try {
    await store.put(bytesKey(attempt.ownerPart, attempt.uploadId, attempt.attemptId), input.chunk)
  } catch (error) {
    await endAttempt(store, attempt, [attempt.attemptId])
    throw error
  }

  const committed = await changeManifest(store, attempt, (manifest) => commit(manifest, attempt))
  if (committed.kind === 'refused') {
    await deleteBytes(store, attempt, [attempt.attemptId])
    throw new UploadConflictError(TOO_LATE)
  }
  if (committed.kind === 'received') return { status: 'received' }

  const opened = openAssembled(store, attempt, committed.chunks)
  try {
    return { status: 'finished', result: await finish(opened.assembled) }
  } finally {
    await opened.removeFile()
    await endAttempt(store, attempt, committed.chunks.map((chunk) => chunk.attemptId))
  }
}

/**
 * The attempts a manifest still refers to. Once neither a chunk nor the write
 * slot names an attempt, nothing can again: a commit needs the slot, and an
 * attempt takes it before it writes. So bytes found unreferenced here stay dead
 * whatever happens after the read.
 */
function referencedAttempts(manifest: UploadManifest | null): Set<string> {
  if (manifest?.state !== 'receiving' && manifest?.state !== 'finalizing') return new Set()
  const committed = manifest.chunks.map((chunk) => chunk.attemptId)
  return new Set(manifest.state === 'receiving' && manifest.writing ? [...committed, manifest.writing] : committed)
}

const BYTES_KEY = new RegExp(`^${UPLOAD_BYTES_PREFIX}([^/]+)/([^/]+)/((\\d+)-[^/]+)$`)

/**
 * Bytes older than `maxAgeMs` that their manifest no longer refers to, or whose
 * manifest is gone: an abandoned upload, a crash, a delete that failed. Age is
 * read from the key, by the writer's clock, since not every store can tell it.
 * It decides only when an unreferenced blob goes: bytes that are referenced stay
 * at any age, whatever the clocks say.
 */
async function removeStaleBytes(maxAgeMs: number, nowMs: number): Promise<void> {
  const store = uploadByteStore()
  const staleByUpload = new Map<string, { ownerPart: string; uploadId: string; blobs: { key: string; attemptId: string }[] }>()
  for (const { key } of await store.list(UPLOAD_BYTES_PREFIX)) {
    const match = BYTES_KEY.exec(key)
    if (!match) continue
    const [, ownerPart, uploadId, attemptId, startedAt] = match
    if (nowMs - Number(startedAt) <= maxAgeMs) continue
    const group = staleByUpload.get(`${ownerPart}/${uploadId}`) ?? { ownerPart, uploadId, blobs: [] }
    group.blobs.push({ key, attemptId })
    staleByUpload.set(`${ownerPart}/${uploadId}`, group)
  }
  for (const { ownerPart, uploadId, blobs } of staleByUpload.values()) {
    let referenced: Set<string>
    try {
      referenced = referencedAttempts((await appState().get(manifestKey(ownerPart, uploadId)))?.value ?? null)
    } catch (err) {
      // Unknown is not unreferenced: the next sweep tries again.
      ignoreCleanupError(err, 'read-manifest-for-sweep', { uploadId })
      continue
    }
    await Promise.all(blobs.filter((blob) => !referenced.has(blob.attemptId)).map(async ({ key }) => {
      try {
        await store.delete(key)
      } catch (err) {
        ignoreCleanupError(err, 'delete-stale-bytes', { key })
      }
    }))
  }
}

/** Files `toFile` wrote that a crash left behind. While the upload is `finalizing` they stay, at any age. */
async function removeStaleAssembledFiles(maxAgeMs: number, nowMs: number): Promise<void> {
  const dir = path.join(getTempUploadsDir(), ASSEMBLED_DIR)
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (err) {
    ignoreCleanupError(err, 'readdir-assembled', { dir })
    return
  }
  for (const name of names) {
    const filePath = path.join(dir, name)
    try {
      if (nowMs - (await fs.promises.stat(filePath)).mtimeMs <= maxAgeMs) continue
      const [ownerPart, uploadId] = name.split('.')
      const manifest = ownerPart && uploadId ? (await appState().get(manifestKey(ownerPart, uploadId)))?.value : null
      if (manifest?.state === 'finalizing') continue
      await fs.promises.unlink(filePath)
    } catch (err) {
      ignoreCleanupError(err, 'remove-stale-assembled', { filePath })
    }
  }
}

/** The layout before manifests: `{uploadId}/chunk-{n}` and `{uploadId}.assembled`, judged by age alone. */
async function removeStaleLegacyEntries(maxAgeMs: number, nowMs: number): Promise<void> {
  const uploadsDir = getTempUploadsDir()
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true })
  } catch (err) {
    ignoreCleanupError(err, 'readdir-temp-uploads', { uploadsDir })
    return
  }
  for (const entry of entries) {
    if (entry.name === LOCAL_CHUNKS_DIR || entry.name === ASSEMBLED_DIR) continue
    const entryPath = path.join(uploadsDir, entry.name)
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(entryPath)
    } catch (err) {
      ignoreCleanupError(err, 'stat-temp-upload-entry', { entryPath })
      continue
    }
    if (nowMs - stat.mtimeMs <= maxAgeMs) continue
    if (entry.isDirectory()) {
      try {
        await removeDirectory(entryPath)
      } catch (err) {
        ignoreCleanupError(err, 'remove-stale-upload-dir', { entryPath })
      }
    } else {
      try {
        await fs.promises.unlink(entryPath)
      } catch (err) {
        ignoreCleanupError(err, 'unlink-stale-assembled', { entryPath })
      }
    }
  }
}

/** Expiring a manifest deletes no bytes, so this finds what is left. */
export async function cleanupStaleTempUploads(maxAgeMs: number, nowMs: number = Date.now()): Promise<void> {
  await removeStaleLegacyEntries(maxAgeMs, nowMs)
  await removeStaleBytes(maxAgeMs, nowMs)
  await removeStaleAssembledFiles(maxAgeMs, nowMs)
}

let staleUploadSweeps = false

function sweepStaleUploads(): void {
  background(cleanupStaleTempUploads(STALE_UPLOAD_AGE_MS), { name: 'chunked-upload.sweep-stale' })
}

// Sets a sweep going and returns, so a slow sweep does not hold up the next.
const staleUploadSweepTask = new PassTask('uploads.stale-sweep', async () => sweepStaleUploads())

/**
 * Sweeps now and then every 30 minutes, until `stopStaleUploadCleanup`. Called
 * from `afterBindInitialize`, once AppState is initialized, so that importing the
 * routes starts no timers. A second start changes nothing.
 */
export function startStaleUploadCleanup(): void {
  if (staleUploadSweeps) return
  staleUploadSweeps = true
  sweepStaleUploads()
  taskManager().register(staleUploadSweepTask)
  background(taskManager().ensureEvery(staleUploadSweepTask.type, staleUploadSweepTask.spec, { intervalMs: STALE_UPLOAD_SWEEP_EVERY_MS }), { name: 'chunked-upload.schedule-sweep' })
}

/** Stops the sweeps (shutdown). A sweep in flight finishes. */
export function stopStaleUploadCleanup(): void {
  if (!staleUploadSweeps) return
  staleUploadSweeps = false
  background(taskManager().cancel(staleUploadSweepTask.type), { name: 'chunked-upload.cancel-sweep' })
}
