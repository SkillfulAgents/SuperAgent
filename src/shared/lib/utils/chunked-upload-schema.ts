/**
 * What AppState holds for one chunked upload (`chunked-upload.ts` owns the
 * transitions). Bytes are never here, only which attempt holds each chunk.
 */
import { z } from 'zod'

/** Chunks one upload may have. */
export const MAX_UPLOAD_CHUNKS = 200

/** A client-chosen id that becomes part of a path: UUID shaped, so it cannot traverse. */
export const uploadIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

/**
 * One try at writing one chunk, and the name of its bytes: when it started, by
 * its writer's clock, then a random id. No two attempts share a name, so a
 * failed or repeated write cannot touch a committed chunk's bytes.
 */
export const uploadAttemptIdSchema = z.string().regex(/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

const chunkHashSchema = z.string().min(1).max(128)
const chunkSizeSchema = z.number().int().nonnegative()

const committedChunkSchema = z.object({
  attemptId: uploadAttemptIdSchema,
  hash: chunkHashSchema,
  size: chunkSizeSchema,
})

const reservationSchema = z.object({
  index: z.number().int().nonnegative().max(MAX_UPLOAD_CHUNKS - 1),
  hash: chunkHashSchema,
  size: chunkSizeSchema,
  /** Epoch ms, by the reserving process's clock: from then on the next write may drop it. */
  expiresAt: z.number().finite(),
})

/** What a request that ended the upload answered. A retry gets the same. */
export const uploadResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.json(),
})

/** Fixed by the chunk that created the manifest. A chunk that says otherwise is refused. */
const uploadIdentity = {
  /** What the assembled file is for, such as `agent:{slug}`. */
  target: z.string().min(1).max(512),
  totalChunks: z.number().int().min(1).max(MAX_UPLOAD_CHUNKS),
  maxBytes: z.number().int().positive(),
  /** Committed chunks by index, as a string. */
  chunks: z.record(z.string().regex(/^\d+$/), committedChunkSchema),
}

export const uploadManifestSchema = z.discriminatedUnion('state', [
  z.object({
    ...uploadIdentity,
    state: z.literal('receiving'),
    /** Attempts writing their bytes now, by attempt id. They count against `maxBytes`. */
    reservations: z.record(uploadAttemptIdSchema, reservationSchema),
  }),
  z.object({
    ...uploadIdentity,
    state: z.literal('finalizing'),
    /** The lease owner who took it last, null until one has. Only that owner may publish. */
    finalizer: z.string().min(1).nullable(),
  }),
  z.object({
    ...uploadIdentity,
    state: z.literal('completed'),
    finalizer: z.string().min(1),
    /** Null when it was too large to keep. */
    response: uploadResponseSchema.nullable(),
  }),
  z.object({
    ...uploadIdentity,
    state: z.literal('too_large'),
    /** The size that went over `maxBytes`. */
    size: z.number().int().positive(),
  }),
])

export type UploadManifest = z.infer<typeof uploadManifestSchema>
export type UploadResponse = z.infer<typeof uploadResponseSchema>
