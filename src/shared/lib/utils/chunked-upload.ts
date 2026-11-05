/**
 * Chunked uploads, for every process that serves a tenant. AppState holds one
 * manifest per upload and decides everything; a byte store only keeps bytes
 * (`chunked-upload-bytes.ts`). docs/app-state.md has the design.
 *
 * A chunk reserves its bytes in the manifest, writes them under a key no other
 * attempt uses, then commits. The commit that completes the upload also moves
 * it to `finalizing`, in one compare-and-set, so of chunks arriving together
 * exactly one does it. Completion is never read from a listing of bytes.
 *
 * Each change is a reducer that recognises its own attempt or token in the
 * record, so a write whose answer was lost settles by deciding again from what
 * is stored (`settle`).
 *
 * The file is assembled and handed to the caller under a renewable lease, which
 * keeps two processes from doing that at once. It does not make the caller's
 * work exactly once: a takeover after a crash runs it again.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as NodeReadableStream } from 'stream/web'
import {
  appState,
  defineLease,
  defineNamespace,
  digestKeyPart,
  isAppStateInitialized,
  reduceRecord,
  type RecordChange,
  type StateKey,
} from '@shared/lib/app-state'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'
import { LOCAL_CHUNKS_DIR, UPLOAD_BYTES_PREFIX, uploadByteStore, type UploadByteStore } from './chunked-upload-bytes'
import {
  MAX_UPLOAD_CHUNKS,
  uploadIdSchema,
  uploadManifestSchema,
  type UploadManifest,
  type UploadResponse,
} from './chunked-upload-schema'
import { ensureDirectory, getTempUploadsDir, removeDirectory } from './file-storage'

// Workspace chat/file uploads. Streaming assembly keeps RAM O(chunk); this caps disk.
export const MAX_UPLOAD_TOTAL_SIZE = 2 * 1024 * 1024 * 1024

/** A manifest's life after its last write. Matches the sweep's age: an abandoned upload is gone an hour after it stopped. */
export const UPLOAD_IDLE_EXPIRY_MS = 60 * 60 * 1000
/** How long a retry can still get the answer of a finished upload, from when it finished. */
export const UPLOAD_RESULT_RETENTION_MS = 60 * 60 * 1000
/**
 * How long an attempt's reservation counts without a commit. Far longer than
 * one chunk's write. Judged by whichever process writes next: a skewed clock
 * can only drop one early, and that attempt's commit is then refused.
 */
export const UPLOAD_RESERVATION_MS = 10 * 60 * 1000
/**
 * The finalizer's lease, renewed every 40 s while it assembles and while the
 * caller works. How long a retry waits when a finalizer died. A process stalled
 * this long (a sleeping laptop) loses the lease, and can only refuse itself.
 */
export const UPLOAD_FINALIZER_LEASE_MS = 2 * 60 * 1000
/** What must be left of the lease when the caller's work starts. */
const FINALIZER_CONFIRM_MARGIN_MS = 30_000
/** How often a running finalizer writes the manifest, so it cannot idle out from under the work. */
const MANIFEST_TOUCH_MS = 15 * 60 * 1000
/** Attempts of one upload in flight at once. Bounds the record, and what can sit on disk past the cap. */
const MAX_RESERVATIONS = 64
/** A larger answer is not kept: a retry is told the upload finished, without it. */
const MAX_RETAINED_RESPONSE_CHARS = 64 * 1024
/** Decisions per change. A conflict means another write landed, and up to 200 chunks may land together. */
const MAX_DECISIONS = 1024
const LOST_ANSWER_ATTEMPTS = 3
const LOST_ANSWER_PAUSE_MS = 100
/** Below the temp uploads dir: files being assembled and handed to a caller. */
const ASSEMBLED_DIR = 'assembled'

const uploads = defineNamespace({
  name: 'upload',
  consistency: 'strong',
  schema: uploadManifestSchema,
  expiry: { ttlMs: UPLOAD_IDLE_EXPIRY_MS, onUpdate: 'reset' },
})

const finalizerLease = defineLease({ name: 'claim:upload-finalize', ttlMs: UPLOAD_FINALIZER_LEASE_MS })

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

export interface StoreChunkInput {
  /** The authenticated user. Their upload ids and bytes are their own. */
  ownerId: string
  uploadId: string
  /** What the assembled file is for, such as `agent:{slug}`. */
  target: string
  chunkIndex: number
  totalChunks: number
  chunk: Buffer
  maxTotalBytes: number
}

export interface AssembledUpload {
  /** The whole file on this machine. The caller may move it; anything left is removed after `finish`. */
  filePath: string
  size: number
}

/**
 * Consumes the assembled file. What it returns is the answer a retry gets, so
 * it returns its failures too; a throw leaves the upload for a retry to run again.
 */
export type FinishUpload = (assembled: AssembledUpload) => Promise<UploadResponse>

export type StoreChunkResult =
  | { status: 'received' }
  /** Another request is assembling or consuming this upload. Try again shortly. */
  | { status: 'finalizing' }
  /** The upload has ended: this request's `finish`, or the answer kept from the one that ran. */
  | { status: 'finished'; response: UploadResponse }

export type { UploadResponse }

/** One try at storing one chunk. */
interface ChunkAttempt {
  key: StateKey<UploadManifest, 'strong'>
  ownerPart: string
  uploadId: string
  target: string
  totalChunks: number
  maxBytes: number
  index: number
  hash: string
  size: number
  attemptId: string
}

/** How a request ends once the manifest has decided. */
type NextStep =
  | { kind: 'received' }
  | { kind: 'finalize' }
  | { kind: 'finished'; response: UploadResponse | null }
  | { kind: 'too_large'; size: number; committed: string[] }
  | { kind: 'conflict'; message: string }

interface CommitOutcome {
  next: NextStep
  /** The manifest refers to this attempt's bytes. Otherwise they are deleted. */
  keepBytes: boolean
  /** The attempt whose chunk this one replaced, when this decision did. */
  replaced: string | null
}

type TakeOver =
  | { kind: 'mine'; manifest: UploadManifest }
  | { kind: 'ended'; response: UploadResponse | null }
  | { kind: 'gone' }

const DIFFERENT_DETAILS = 'This upload was started with different details'
const ALREADY_ASSEMBLING = 'This upload is already being assembled and has a different chunk at this position'
const ALREADY_FINISHED = 'This upload has already finished, with a different chunk at this position'
const EXPIRED = 'This upload has expired. Please start it again'
const RESERVATION_LOST = 'This chunk took too long to store. Please send it again'
const TOO_MANY_WRITES = 'Too many chunks of this upload are being written at once'
const RESULT_NOT_KEPT = 'This upload has already finished'

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

function assembledPath(ownerPart: string, uploadId: string, token: string): string {
  return path.join(getTempUploadsDir(), ASSEMBLED_DIR, `${ownerPart}.${uploadId}.${token}`)
}

async function describeAttempt(input: StoreChunkInput): Promise<ChunkAttempt> {
  const { chunkIndex, totalChunks, maxTotalBytes } = input
  const uploadId = uploadIdSchema.parse(input.uploadId).toLowerCase()
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_UPLOAD_CHUNKS) {
    throw new RangeError(`An upload has 1 to ${MAX_UPLOAD_CHUNKS} chunks`)
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new RangeError('The chunk index is outside the upload')
  }
  const ownerPart = ownerPartOf(input.ownerId)
  // Off the event loop: a chunk can be hundreds of megabytes.
  const digest = await crypto.subtle.digest('SHA-256', input.chunk as Uint8Array<ArrayBuffer>)
  return {
    key: manifestKey(ownerPart, uploadId),
    ownerPart,
    uploadId,
    target: input.target,
    totalChunks,
    maxBytes: maxTotalBytes,
    index: chunkIndex,
    hash: Buffer.from(digest).toString('base64url'),
    size: input.chunk.byteLength,
    attemptId: `${Date.now()}-${randomUUID()}`,
  }
}

function describesSameUpload(manifest: UploadManifest, attempt: ChunkAttempt): boolean {
  return manifest.target === attempt.target && manifest.totalChunks === attempt.totalChunks && manifest.maxBytes === attempt.maxBytes
}

type Reservations = Extract<UploadManifest, { state: 'receiving' }>['reservations']

function liveReservations(reservations: Reservations, now: number, except?: string): Reservations {
  return Object.fromEntries(
    Object.entries(reservations).filter(([attemptId, reservation]) => attemptId !== except && now < reservation.expiresAt),
  )
}

/**
 * What the file would be at most. Each index counts its largest chunk, committed
 * or in flight, since one of them ends up there: a replacement is not counted
 * twice, and bytes on their way count before they are written.
 */
function projectedBytes(chunks: UploadManifest['chunks'], reservations: Reservations, attempt: ChunkAttempt): number {
  const largest = new Map<number, number>()
  const count = (index: number, size: number) => largest.set(index, Math.max(largest.get(index) ?? 0, size))
  for (const [index, chunk] of Object.entries(chunks)) count(Number(index), chunk.size)
  for (const reservation of Object.values(reservations)) count(reservation.index, reservation.size)
  count(attempt.index, attempt.size)
  let total = 0
  for (const size of largest.values()) total += size
  return total
}

function committedAttempts(chunks: UploadManifest['chunks']): string[] {
  return Object.values(chunks).map((chunk) => chunk.attemptId)
}

/** What a chunk gets from an upload that stopped receiving. */
function stepAfterReceiving(manifest: Exclude<UploadManifest, { state: 'receiving' }>, attempt: ChunkAttempt): NextStep {
  if (manifest.state === 'too_large') {
    return { kind: 'too_large', size: manifest.size, committed: committedAttempts(manifest.chunks) }
  }
  const sameChunk = manifest.chunks[attempt.index]?.hash === attempt.hash
  if (manifest.state === 'finalizing') {
    return sameChunk ? { kind: 'finalize' } : { kind: 'conflict', message: ALREADY_ASSEMBLING }
  }
  return sameChunk ? { kind: 'finished', response: manifest.response } : { kind: 'conflict', message: ALREADY_FINISHED }
}

/** The first step: a chunk the upload already has writes nothing, any other reserves its bytes. */
function reserve(manifest: UploadManifest | null, attempt: ChunkAttempt): RecordChange<UploadManifest, NextStep | { kind: 'write' }> {
  if (manifest && !describesSameUpload(manifest, attempt)) return { result: { kind: 'conflict', message: DIFFERENT_DETAILS } }
  if (manifest && manifest.state !== 'receiving') return { result: stepAfterReceiving(manifest, attempt) }
  if (manifest?.reservations[attempt.attemptId]) return { result: { kind: 'write' } }
  const chunks = manifest?.chunks ?? {}
  if (chunks[attempt.index]?.hash === attempt.hash) return { result: { kind: 'received' } }

  const now = Date.now()
  const reservations = liveReservations(manifest?.reservations ?? {}, now)
  if (Object.keys(reservations).length >= MAX_RESERVATIONS) return { result: { kind: 'conflict', message: TOO_MANY_WRITES } }
  const identity = { target: attempt.target, totalChunks: attempt.totalChunks, maxBytes: attempt.maxBytes, chunks }
  const size = projectedBytes(chunks, reservations, attempt)
  if (size > attempt.maxBytes) {
    return {
      result: { kind: 'too_large', size, committed: committedAttempts(chunks) },
      value: { ...identity, state: 'too_large', size },
      expiry: { ttlMs: UPLOAD_RESULT_RETENTION_MS },
    }
  }
  return {
    result: { kind: 'write' },
    value: {
      ...identity,
      state: 'receiving',
      reservations: {
        ...reservations,
        [attempt.attemptId]: { index: attempt.index, hash: attempt.hash, size: attempt.size, expiresAt: now + UPLOAD_RESERVATION_MS },
      },
    },
  }
}

/**
 * The last step for bytes that were written. The commit that leaves no chunk
 * missing also moves the upload to `finalizing`: that is the claim, one write,
 * so simultaneous last chunks can neither both miss it nor both make it. Any
 * attempt still in flight then is refused when it gets here.
 */
function commit(manifest: UploadManifest | null, attempt: ChunkAttempt): RecordChange<UploadManifest, CommitOutcome> {
  const refused = (message: string): RecordChange<UploadManifest, CommitOutcome> => ({
    result: { next: { kind: 'conflict', message }, keepBytes: false, replaced: null },
  })
  // Absent: it expired, and this attempt's guard with it. A commit never creates a record.
  if (!manifest) return refused(EXPIRED)
  if (!describesSameUpload(manifest, attempt)) return refused(DIFFERENT_DETAILS)

  const committed = manifest.chunks[attempt.index]
  const isMine = committed?.attemptId === attempt.attemptId
  if (manifest.state !== 'receiving') {
    return { result: { next: stepAfterReceiving(manifest, attempt), keepBytes: isMine, replaced: null } }
  }
  // Our commit landed and its answer was lost.
  if (isMine) return { result: { next: { kind: 'received' }, keepBytes: true, replaced: null } }

  const reservations = liveReservations(manifest.reservations, Date.now(), attempt.attemptId)
  if (committed?.hash === attempt.hash) {
    return { result: { next: { kind: 'received' }, keepBytes: false, replaced: null }, value: { ...manifest, reservations } }
  }
  if (!manifest.reservations[attempt.attemptId]) return refused(RESERVATION_LOST)

  const chunks = { ...manifest.chunks, [attempt.index]: { attemptId: attempt.attemptId, hash: attempt.hash, size: attempt.size } }
  const replaced = committed?.attemptId ?? null
  if (Object.keys(chunks).length === manifest.totalChunks) {
    const { target, totalChunks, maxBytes } = manifest
    return {
      result: { next: { kind: 'finalize' }, keepBytes: true, replaced },
      value: { target, totalChunks, maxBytes, chunks, state: 'finalizing', finalizer: null },
    }
  }
  return { result: { next: { kind: 'received' }, keepBytes: true, replaced }, value: { ...manifest, chunks, reservations } }
}

/** An attempt whose write failed gives its reservation back. */
function release(manifest: UploadManifest | null, attemptId: string): RecordChange<UploadManifest, void> {
  if (manifest?.state !== 'receiving' || !manifest.reservations[attemptId]) return { result: undefined }
  return { result: undefined, value: { ...manifest, reservations: liveReservations(manifest.reservations, Date.now(), attemptId) } }
}

/** The lease holder names itself in the manifest, which fences whoever held it before. */
function takeOver(manifest: UploadManifest | null, token: string): RecordChange<UploadManifest, TakeOver> {
  if (manifest?.state === 'completed') return { result: { kind: 'ended', response: manifest.response } }
  if (manifest?.state !== 'finalizing') return { result: { kind: 'gone' } }
  if (manifest.finalizer === token) return { result: { kind: 'mine', manifest } }
  const next = { ...manifest, finalizer: token }
  return { result: { kind: 'mine', manifest: next }, value: next }
}

/**
 * Keeps the answer, while the manifest still names this holder. The lease may
 * have lapsed by now; what fences is the name, since a successor writes its own
 * before it does anything. Without a successor the answer is still the truth.
 */
function publish(manifest: UploadManifest | null, token: string, response: UploadResponse | null): RecordChange<UploadManifest, boolean> {
  if (manifest?.state === 'completed' && manifest.finalizer === token) return { result: true }
  if (manifest?.state !== 'finalizing' || manifest.finalizer !== token) return { result: false }
  const { target, totalChunks, maxBytes, chunks } = manifest
  return {
    result: true,
    value: { target, totalChunks, maxBytes, chunks, state: 'completed', finalizer: token, response },
    expiry: { ttlMs: UPLOAD_RESULT_RETENTION_MS },
  }
}

/**
 * One change to a manifest. A failure may be a write that landed with its answer
 * lost, so the change is decided again from what is stored; each reducer above
 * recognises its own attempt or token there. If this throws, the outcome is
 * unknown and the caller must not assume either way.
 */
async function settle<R>(key: StateKey<UploadManifest, 'strong'>, reduce: (manifest: UploadManifest | null) => RecordChange<UploadManifest, R>): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await reduceRecord(key, reduce, { maxAttempts: MAX_DECISIONS })
    } catch (error) {
      if (attempt >= LOST_ANSWER_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * LOST_ANSWER_PAUSE_MS))
    }
  }
}

/** Deletes bytes nothing refers to. One that stays is the sweep's to remove. */
async function deleteBytes(store: UploadByteStore, keys: string[], op: string): Promise<void> {
  await Promise.all(keys.map(async (key) => {
    try {
      await store.delete(key)
    } catch (err) {
      ignoreCleanupError(err, op, { key })
    }
  }))
}

async function writeAndCommit(store: UploadByteStore, attempt: ChunkAttempt, chunk: Buffer): Promise<NextStep> {
  const key = bytesKey(attempt.ownerPart, attempt.uploadId, attempt.attemptId)
  try {
    await store.put(key, chunk)
  } catch (error) {
    try {
      await settle(attempt.key, (manifest) => release(manifest, attempt.attemptId))
    } catch (releaseError) {
      // It stops counting at its expiry.
      ignoreCleanupError(releaseError, 'release-reservation', { uploadId: attempt.uploadId })
    }
    await deleteBytes(store, [key], 'delete-failed-write')
    throw error
  }
  // A throw here leaves the bytes alone: the commit may have landed.
  const outcome = await settle(attempt.key, (manifest) => commit(manifest, attempt))
  const unreferenced = outcome.replaced ? [bytesKey(attempt.ownerPart, attempt.uploadId, outcome.replaced)] : []
  if (!outcome.keepBytes) unreferenced.push(key)
  await deleteBytes(store, unreferenced, 'delete-unreferenced-chunk')
  return outcome.next
}

async function assemble(store: UploadByteStore, attempt: ChunkAttempt, manifest: UploadManifest, filePath: string, signal: AbortSignal): Promise<number> {
  await ensureDirectory(path.dirname(filePath))
  let expected = 0
  for (let index = 0; index < manifest.totalChunks; index++) {
    const chunk = manifest.chunks[index]
    if (!chunk) throw new Error(`Upload chunk ${index} is not in the manifest`)
    const source = await store.stream(bytesKey(attempt.ownerPart, attempt.uploadId, chunk.attemptId))
    if (!source) throw new Error(`Upload chunk ${index} is missing`)
    await pipeline(
      Readable.fromWeb(source as NodeReadableStream),
      fs.createWriteStream(filePath, { flags: index === 0 ? 'w' : 'a' }),
      { signal },
    )
    expected += chunk.size
  }
  const { size } = await fs.promises.stat(filePath)
  if (size !== expected) throw new Error(`Assembled upload is ${size} bytes, its chunks ${expected}`)
  return size
}

/** Writes the manifest now and then for as long as this holder runs: a touch resets its idle expiry. */
function keepManifestAlive(key: StateKey<UploadManifest, 'strong'>, token: string): () => void {
  const touch = async () => {
    try {
      await reduceRecord(key, (manifest): RecordChange<UploadManifest, void> => (
        manifest?.state === 'finalizing' && manifest.finalizer === token ? { result: undefined, value: manifest } : { result: undefined }
      ), { maxAttempts: MAX_DECISIONS })
    } catch (error) {
      // AppState is out of reach: the lease's own renewal says what that means.
      console.warn('[chunked-upload] could not touch a finalizing manifest:', error)
    }
  }
  const timer = setInterval(() => background(touch(), { name: 'chunked-upload.touch-manifest' }), MANIFEST_TOUCH_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

function endedResult(response: UploadResponse | null): StoreChunkResult {
  if (!response) throw new UploadConflictError(RESULT_NOT_KEPT)
  return { status: 'finished', response }
}

/**
 * Runs the upload's end, unless someone else holds the lease. Whoever finds an
 * upload `finalizing` comes here, not only the chunk that moved it there: that
 * is how a retry takes over from a finalizer that died.
 */
async function finalize(store: UploadByteStore, attempt: ChunkAttempt, finish: FinishUpload): Promise<StoreChunkResult> {
  const lease = await finalizerLease.acquire(finalizerLease.key(attempt.ownerPart, attempt.uploadId))
  if (!lease) return { status: 'finalizing' }
  return finalizerLease.hold(lease, async (holding) => {
    const token = holding.owner
    const taken = await settle(attempt.key, (manifest) => takeOver(manifest, token))
    if (taken.kind === 'ended') return endedResult(taken.response)
    if (taken.kind === 'gone') throw new UploadConflictError(EXPIRED)

    const stopTouching = keepManifestAlive(attempt.key, token)
    const filePath = assembledPath(attempt.ownerPart, attempt.uploadId, token)
    try {
      let size: number
      try {
        size = await assemble(store, attempt, taken.manifest, filePath, holding.signal)
        await holding.confirm({ minRemainingMs: FINALIZER_CONFIRM_MARGIN_MS })
      } catch (error) {
        // Nothing has been done with the bytes, so whoever holds the lease next can start over.
        if (holding.signal.aborted) return { status: 'finalizing' }
        throw error
      }
      const response = await finish({ filePath, size })
      await publishAndDiscard(store, attempt, taken.manifest, token, response)
      return { status: 'finished', response }
    } finally {
      stopTouching()
      await fs.promises.unlink(filePath).catch((err: unknown) => ignoreCleanupError(err, 'unlink-assembled', { filePath }))
    }
  })
}

/**
 * The work is done whatever happens here, so a failure is reported, not thrown.
 * Only a holder whose answer was kept deletes the chunks: a successor may be
 * reading them.
 */
async function publishAndDiscard(store: UploadByteStore, attempt: ChunkAttempt, manifest: UploadManifest, token: string, response: UploadResponse): Promise<void> {
  const retained = JSON.stringify(response.body).length <= MAX_RETAINED_RESPONSE_CHARS ? response : null
  let published: boolean
  try {
    published = await settle(attempt.key, (current) => publish(current, token, retained))
  } catch (error) {
    console.warn('[chunked-upload] could not keep an upload\'s answer; a retry may run it again:', error)
    captureException(error, { tags: { area: 'chunked-upload', op: 'publish-result' }, extra: { uploadId: attempt.uploadId } })
    return
  }
  if (!published) return
  const keys = committedAttempts(manifest.chunks).map((attemptId) => bytesKey(attempt.ownerPart, attempt.uploadId, attemptId))
  await deleteBytes(store, keys, 'delete-finished-chunks')
}

/**
 * Stores one chunk of an upload. `finish` runs once every chunk is stored, in
 * the request that gets the lease, and gets the assembled file. A chunk the
 * upload already has is not stored again: it gets `received`, `finalizing`, or
 * the kept answer, whichever the upload's state says.
 *
 * @throws UploadTooLargeError when the upload no longer fits `maxTotalBytes`; it stays refused
 * @throws UploadConflictError when this chunk does not fit the upload as stored
 */
export async function storeUploadChunk(input: StoreChunkInput, finish: FinishUpload): Promise<StoreChunkResult> {
  const store = uploadByteStore()
  const attempt = await describeAttempt(input)
  const decided = await settle(attempt.key, (manifest) => reserve(manifest, attempt))
  const next = decided.kind === 'write' ? await writeAndCommit(store, attempt, input.chunk) : decided
  switch (next.kind) {
    case 'received':
      return { status: 'received' }
    case 'finalize':
      return finalize(store, attempt, finish)
    case 'finished':
      return endedResult(next.response)
    case 'too_large': {
      const keys = next.committed.map((attemptId) => bytesKey(attempt.ownerPart, attempt.uploadId, attemptId))
      await deleteBytes(store, keys, 'delete-oversized-upload')
      throw new UploadTooLargeError(next.size, attempt.maxBytes)
    }
    case 'conflict':
      throw new UploadConflictError(next.message)
  }
}

/**
 * The attempts a manifest still refers to. Once neither a chunk nor a
 * reservation names an attempt, nothing can again: a commit needs a reservation,
 * and an attempt reserves before it writes. So bytes found unreferenced here
 * stay dead whatever happens after the read.
 */
function referencedAttempts(manifest: UploadManifest | null): Set<string> {
  if (manifest?.state === 'receiving') return new Set([...committedAttempts(manifest.chunks), ...Object.keys(manifest.reservations)])
  if (manifest?.state === 'finalizing') return new Set(committedAttempts(manifest.chunks))
  return new Set()
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
    const unreferenced = blobs.filter((blob) => !referenced.has(blob.attemptId)).map((blob) => blob.key)
    await deleteBytes(store, unreferenced, 'delete-stale-bytes')
  }
}

/** Assembled files a crash or a lost lease left behind. The one a live finalizer is using stays, at any age. */
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
      const [ownerPart, uploadId, token] = name.split('.')
      const manifest = ownerPart && uploadId && token ? (await appState().get(manifestKey(ownerPart, uploadId)))?.value : null
      if (manifest?.state === 'finalizing' && manifest.finalizer === token) continue
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

/**
 * Expiring a manifest deletes no bytes, so this finds what is left. Without
 * AppState it cannot tell a live upload's bytes from an abandoned one's, and
 * leaves them to the next sweep.
 */
export async function cleanupStaleTempUploads(maxAgeMs: number, nowMs: number = Date.now()): Promise<void> {
  await removeStaleLegacyEntries(maxAgeMs, nowMs)
  if (!isAppStateInitialized()) return
  await removeStaleBytes(maxAgeMs, nowMs)
  await removeStaleAssembledFiles(maxAgeMs, nowMs)
}
