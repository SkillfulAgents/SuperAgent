/**
 * What AppState holds for one chunked upload (`chunked-upload.ts` owns the
 * transitions). Bytes are never here, only which attempt wrote each chunk.
 */
import { z } from 'zod'

/** Chunks one upload may have. */
export const MAX_UPLOAD_CHUNKS = 200

/** A client-chosen id that becomes part of a path: UUID shaped, so it cannot traverse. */
export const uploadIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

/**
 * One try at writing one chunk, and the name of its bytes: when it started, by
 * its writer's clock, then a random id. No two attempts share a name, so a late
 * write cannot touch anything but its own bytes.
 */
export const uploadAttemptIdSchema = z.string().regex(/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

const committedChunkSchema = z.object({
  attemptId: uploadAttemptIdSchema,
  size: z.number().int().nonnegative(),
})

/** Committed chunks in order: a chunk's place in the list is its index. */
const committedChunksSchema = z.array(committedChunkSchema).max(MAX_UPLOAD_CHUNKS)

/** Fixed by chunk 0. A chunk that says otherwise is refused. */
const uploadIdentity = {
  /** What the upload is for, such as `agent:{slug}`. */
  target: z.string().min(1).max(512),
  totalChunks: z.number().int().min(1).max(MAX_UPLOAD_CHUNKS),
  maxBytes: z.number().int().positive(),
}

export const uploadManifestSchema = z.discriminatedUnion('state', [
  z.object({
    ...uploadIdentity,
    state: z.literal('receiving'),
    chunks: committedChunksSchema,
    /** The attempt writing the next chunk now. While it is set, every other chunk is refused. */
    writing: uploadAttemptIdSchema.nullable(),
  }),
  z.object({
    ...uploadIdentity,
    state: z.literal('finalizing'),
    chunks: committedChunksSchema,
  }),
  // The upload succeeded or failed, and this stays until it expires, so later chunks are refused.
  z.object({ state: z.literal('ended') }),
])

export type UploadManifest = z.infer<typeof uploadManifestSchema>
export type CommittedChunk = z.infer<typeof committedChunkSchema>
