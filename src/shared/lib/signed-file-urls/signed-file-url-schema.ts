/**
 * What a signed file URL carries and what redeeming one stores. Every token is
 * parsed with `signedFileTokenPayloadSchema` after its signature checks out,
 * and every AppState record with its namespace schema (signed-file-urls.ts).
 */
import { z } from 'zod'
import { volumeBrowseSchema } from '@shared/lib/volumes/volume-browser-schema'

/** The payload format a token is signed in. A new format gets a new number; old ones stop verifying. */
export const SIGNED_FILE_TOKEN_VERSION = 1

/** How long a minted URL lasts unless the minter asks for less. */
export const DEFAULT_SIGNED_FILE_URL_TTL_MS = 5 * 60_000
/** The longest a minted URL may last: a minter asking for more is refused. */
export const MAX_SIGNED_FILE_URL_TTL_MS = 5 * 60_000

/** NAME_MAX on the filesystems a workspace lives on: a stored upload's name, suffixes included, fits it. */
export const MAX_STORED_UPLOAD_NAME_LENGTH = 255
/** An upload id: 18 random bytes, base64url. */
export const SIGNED_UPLOAD_ID_LENGTH = 24
/**
 * What a stored upload's name adds to the sanitized one: `-<upload id>` (so
 * two uploads never pick one destination) and `withUploadTimestamp`'s
 * `-<13-digit ms timestamp>`.
 */
export const STORED_UPLOAD_NAME_SUFFIX_LENGTH = 1 + SIGNED_UPLOAD_ID_LENGTH + 14
/** The longest name minting keeps, so the stored name fits NAME_MAX. */
export const MAX_SIGNED_UPLOAD_FILENAME_LENGTH = MAX_STORED_UPLOAD_NAME_LENGTH - STORED_UPLOAD_NAME_SUFFIX_LENGTH

/** How a token's issue time may run ahead of this process's clock (another process minted it). */
export const SIGNED_FILE_CLOCK_SKEW_MS = 60_000

/** How long a completed upload's id resolves to its workspace path. */
export const SIGNED_UPLOAD_RESULT_TTL_MS = 60 * 60_000

const idSchema = z.string().min(1).max(256)
const agentSlugSchema = z.string().min(1).max(256)
/** A workspace path as the actor takes it (normalized when minted); never a NUL. */
const workspacePathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid path')
/** A drive path is relative to the drive, the same rule its browser applies. */
const drivePathSchema = volumeBrowseSchema.shape.path.unwrap().pipe(z.string().min(1))

export const workspaceFileTargetSchema = z.object({
  kind: z.literal('workspace-file'),
  agentSlug: agentSlugSchema,
  path: workspacePathSchema,
}).strict()

export const deliveredFileTargetSchema = z.object({
  kind: z.literal('delivered-file'),
  agentSlug: agentSlugSchema,
  sessionId: idSchema,
  deliveryId: idSchema,
}).strict()

export const driveFileTargetSchema = z.object({
  kind: z.literal('drive-file'),
  volumeId: idSchema,
  path: drivePathSchema,
}).strict()

export const agentUploadTargetSchema = z.object({
  kind: z.literal('agent-upload'),
  agentSlug: agentSlugSchema,
  /** Sanitized and shortened when minted; the stored name gets the upload id and a timestamp. */
  filename: z.string().min(1).max(MAX_SIGNED_UPLOAD_FILENAME_LENGTH),
  /** What the upload's record and the completed upload are found by. */
  uploadId: z.string().length(SIGNED_UPLOAD_ID_LENGTH).regex(/^[A-Za-z0-9_-]+$/),
}).strict()

export const signedDownloadTargetSchema = z.discriminatedUnion('kind', [
  workspaceFileTargetSchema,
  deliveredFileTargetSchema,
  driveFileTargetSchema,
])

export type WorkspaceFileTarget = z.infer<typeof workspaceFileTargetSchema>
export type DeliveredFileTarget = z.infer<typeof deliveredFileTargetSchema>
export type DriveFileTarget = z.infer<typeof driveFileTargetSchema>
export type AgentUploadTarget = z.infer<typeof agentUploadTargetSchema>
export type SignedDownloadTarget = z.infer<typeof signedDownloadTargetSchema>

const payloadBase = {
  v: z.literal(SIGNED_FILE_TOKEN_VERSION),
  /** The token's own id: what single use is keyed by. */
  jti: z.string().min(16).max(64),
  /** The user the URL acts for (`local` without auth mode). */
  sub: idSchema,
  /** Issued and expiry instants, epoch ms. */
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}

export const signedFileTokenPayloadSchema = z.discriminatedUnion('op', [
  z.object({ ...payloadBase, op: z.literal('download'), target: signedDownloadTargetSchema }).strict(),
  z.object({ ...payloadBase, op: z.literal('upload'), target: agentUploadTargetSchema }).strict(),
]).refine((payload) => payload.exp > payload.iat && payload.exp - payload.iat <= MAX_SIGNED_FILE_URL_TTL_MS, 'Invalid lifetime')

export type SignedFileTokenPayload = z.infer<typeof signedFileTokenPayloadSchema>
export type SignedFileOperation = SignedFileTokenPayload['op']

/** A completed upload: the workspace path, `/workspace/uploads/…`, as the upload-file route answers it. */
export const signedUploadResultSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
}).strict()
export type SignedUploadResult = z.infer<typeof signedUploadResultSchema>

/**
 * One record per upload URL, from mint to result, found by (user, agent,
 * upload id). `pending` is written when the URL is minted; a PUT moves it to
 * `claimed` while the bytes are written, back to `pending` if the write
 * failed, or to `completed` (spending the URL and holding the result) in one
 * compare-and-set. An absent record is never usable.
 */
export const signedUploadRecordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), jti: z.string().min(1) }).strict(),
  z.object({ state: z.literal('claimed'), jti: z.string().min(1) }).strict(),
  z.object({ state: z.literal('completed'), jti: z.string().min(1), result: signedUploadResultSchema }).strict(),
])
export type SignedUploadRecord = z.infer<typeof signedUploadRecordSchema>
