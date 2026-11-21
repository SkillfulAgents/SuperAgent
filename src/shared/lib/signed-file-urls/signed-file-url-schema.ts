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
  /** Sanitized when minted; the stored name gets a timestamp when the bytes arrive. */
  filename: z.string().min(1).max(255),
  /** What the completed upload is found by later. */
  uploadId: idSchema,
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

/** An upload URL's use: claimed while its bytes are written, used once they landed. */
export const signedUploadClaimSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('claimed') }).strict(),
  z.object({ state: z.literal('used') }).strict(),
])
export type SignedUploadClaim = z.infer<typeof signedUploadClaimSchema>

/** A completed upload, found by (user, agent, upload id). */
export const signedUploadResultSchema = z.object({
  /** The workspace path, `/workspace/uploads/…`, as the upload-file route answers it. */
  path: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
}).strict()
export type SignedUploadResult = z.infer<typeof signedUploadResultSchema>
