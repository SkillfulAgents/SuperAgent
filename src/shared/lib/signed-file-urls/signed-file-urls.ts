/**
 * Signed, user-bound file URLs: a short-lived link that downloads one file, or
 * uploads one file into an agent's `uploads/`, for one user, with no session.
 * The token in the URL is the credential (signed-file-token.ts).
 *
 * Minting is in-process only (no mint endpoint): `mintSignedDownloadUrl` and
 * `mintSignedUploadUrl` check the user's access now and return the absolute
 * URL with its expiry. Redeeming (`GET`/`PUT /api/signed-files/:token`,
 * src/api/routes/signed-files.ts) verifies the token and then checks that
 * access again, so a URL stops working once its user loses the agent or the
 * drive, or their account is no longer active.
 *
 * An upload URL is single use. Its first request claims it in AppState
 * (`insertIfAbsent` on the token id) before any byte is written; a request
 * that fails before the file landed gives the claim back, and one that
 * succeeded marks it used. The completed upload is then found by its upload
 * id, for that user and agent only (`resolveSignedUpload`).
 */
import { eq } from 'drizzle-orm'
import { appState, defineNamespace } from '@shared/lib/app-state'
import { getAppBaseUrl } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { effectiveAgentRole } from '@shared/lib/auth/agent-role'
import { db } from '@shared/lib/db'
import { user as userTable, volumeDefinitions } from '@shared/lib/db/schema'
// The catalog and registry leaves, not the actor package index (see middleware/auth.ts).
import { agentCatalog } from '@shared/lib/agent-actor/agent-catalog'
import { agentRegistry } from '@shared/lib/agent-actor/registry'
import { normalizeWorkspacePath } from '@shared/lib/agent-actor/workspace-path'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'
import { getVisibleVolumeDefinition, openVolumeDefinition, type VolumeViewer } from '@shared/lib/services/volume-service'
import { VolumeError } from '@shared/lib/volumes/volume-error'
import { MAX_UPLOAD_REQUEST_SIZE } from '@shared/lib/utils/chunked-upload'
import { sanitizeUploadFilename } from '@shared/lib/utils/path-safety'
import { resolveUploadDestPath } from '@shared/lib/utils/workspace-upload-path'
import { newTokenId, signFileToken, verifyFileToken } from './signed-file-token'
import {
  DEFAULT_SIGNED_FILE_URL_TTL_MS,
  MAX_SIGNED_FILE_URL_TTL_MS,
  SIGNED_FILE_TOKEN_VERSION,
  SIGNED_UPLOAD_RESULT_TTL_MS,
  signedDownloadTargetSchema,
  signedUploadClaimSchema,
  signedUploadResultSchema,
  type AgentUploadTarget,
  type SignedDownloadTarget,
  type SignedFileOperation,
  type SignedFileTokenPayload,
  type SignedUploadResult,
} from './signed-file-url-schema'

export {
  DEFAULT_SIGNED_FILE_URL_TTL_MS,
  MAX_SIGNED_FILE_URL_TTL_MS,
  SIGNED_UPLOAD_RESULT_TTL_MS,
} from './signed-file-url-schema'
export type { SignedDownloadTarget, SignedFileTokenPayload, SignedUploadResult } from './signed-file-url-schema'

/** Where the redeeming router is mounted. */
export const SIGNED_FILES_ROUTE_PREFIX = '/api/signed-files'

/** A claim outlives its token by this much, so no process with a slower clock sees it gone while the token still verifies. */
const CLAIM_GRACE_MS = 60_000

const uploadClaims = defineNamespace({
  name: 'signed-file:upload-claim',
  consistency: 'strong',
  schema: signedUploadClaimSchema,
  // Every write passes `{ at }`, the token's expiry plus the grace; this is the backstop.
  expiry: { ttlMs: MAX_SIGNED_FILE_URL_TTL_MS + CLAIM_GRACE_MS, onUpdate: 'keep' },
})

const uploadResults = defineNamespace({
  name: 'signed-file:upload',
  consistency: 'strong',
  schema: signedUploadResultSchema,
  expiry: { ttlMs: SIGNED_UPLOAD_RESULT_TTL_MS, onUpdate: 'keep' },
})

/**
 * A refusal, with the HTTP status the redeeming route answers it with. The
 * message is short and says nothing about why beyond what the status does.
 */
export class SignedFileUrlError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'SignedFileUrlError'
  }
}

const INVALID_LINK = () => new SignedFileUrlError(401, 'Invalid or expired link')
const FORBIDDEN = () => new SignedFileUrlError(403, 'Forbidden')
const NOT_FOUND = () => new SignedFileUrlError(404, 'File not found')

export interface SignedFileUrl {
  /** Absolute: the app's external base URL, then `/api/signed-files/<token>`. */
  url: string
  expiresAt: Date
}

export interface MintOptions {
  /** Shorter than the default if wanted; more than `MAX_SIGNED_FILE_URL_TTL_MS` is refused. */
  ttlMs?: number
  /** For tests. */
  now?: number
}

// ---------------------------------------------------------------------------
// Access, decided the same way when minting and when redeeming
// ---------------------------------------------------------------------------

/** Who a URL acts for, as the route middlewares would see them. */
export interface Principal {
  userId: string
  /** Null without auth mode: the one local user, who may use everything. */
  account: { id: string; role: string | null } | null
}

async function principalFor(userId: string, now: number): Promise<Principal> {
  if (!isAuthMode()) {
    // One principal without auth mode; a token minted for anyone else is not for this deployment's mode.
    if (userId !== 'local') throw FORBIDDEN()
    return { userId, account: null }
  }
  const row = await db
    .select({ id: userTable.id, role: userTable.role, status: userTable.status, banned: userTable.banned, banExpires: userTable.banExpires })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .get()
  // An invited user has no account yet; a banned one (until a ban with an end runs out) cannot sign in.
  if (!row || row.status !== 'active') throw FORBIDDEN()
  if (row.banned && !(row.banExpires && row.banExpires.getTime() < now)) throw FORBIDDEN()
  return { userId, account: { id: row.id, role: row.role } }
}

/** The agent's canonical slug, once the principal holds at least `minRole` on it. */
async function requireAgentRole(principal: Principal, agentSlug: string, minRole: AgentRole): Promise<string> {
  const agent = await agentCatalog.resolveRecord(agentSlug)
  if (!agent) throw NOT_FOUND()
  if (principal.account) {
    const role = await effectiveAgentRole(principal.account, agent.slug)
    if (!hasMinRole(role, minRole)) throw FORBIDDEN()
  }
  return agent.slug
}

/** The drive viewer the drive routes build from a request (api/lib/volume-access.ts). */
function driveViewer(principal: Principal): VolumeViewer {
  return principal.account
    ? { userId: principal.account.id, admin: principal.account.role === 'admin' }
    : { userId: null, admin: true }
}

/** A drive the principal can no longer see is refused; one that is gone is not found. */
async function driveRefusal(volumeId: string, error: unknown): Promise<unknown> {
  if (!(error instanceof VolumeError) || error.status !== 404) return error
  const exists = await db.select({ id: volumeDefinitions.id }).from(volumeDefinitions).where(eq(volumeDefinitions.id, volumeId)).get()
  return exists ? FORBIDDEN() : NOT_FOUND()
}

async function requireDriveVisible(principal: Principal, volumeId: string): Promise<void> {
  try {
    await getVisibleVolumeDefinition(volumeId, driveViewer(principal))
  } catch (error) {
    throw await driveRefusal(volumeId, error)
  }
}

/** Opens the drive for the principal, refusing as `requireDriveVisible` does. */
export async function openSignedDrive(principal: Principal, volumeId: string) {
  try {
    return await openVolumeDefinition(volumeId, driveViewer(principal))
  } catch (error) {
    throw await driveRefusal(volumeId, error)
  }
}

/** Checks the principal may do `op` on the target; returns the target with canonical ids. */
async function authorizeTarget<T extends SignedDownloadTarget | AgentUploadTarget>(principal: Principal, target: T): Promise<T> {
  switch (target.kind) {
    case 'workspace-file':
    case 'delivered-file':
      return { ...target, agentSlug: await requireAgentRole(principal, target.agentSlug, 'viewer') }
    case 'agent-upload':
      return { ...target, agentSlug: await requireAgentRole(principal, target.agentSlug, 'user') }
    case 'drive-file':
      await requireDriveVisible(principal, target.volumeId)
      return target
  }
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

function lifetime(options: MintOptions): number {
  const ttlMs = options.ttlMs ?? DEFAULT_SIGNED_FILE_URL_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_SIGNED_FILE_URL_TTL_MS) {
    throw new RangeError(`A signed file URL lasts between 1 ms and ${MAX_SIGNED_FILE_URL_TTL_MS} ms`)
  }
  return ttlMs
}

async function mint(payload: SignedFileTokenPayload): Promise<SignedFileUrl> {
  const token = await signFileToken(payload)
  return { url: `${await getAppBaseUrl()}${SIGNED_FILES_ROUTE_PREFIX}/${token}`, expiresAt: new Date(payload.exp) }
}

/**
 * A URL that downloads one file for `userId`: a workspace file of an agent
 * they can view, a file one of its sessions delivered, or a file on a drive
 * they can see. Throws `SignedFileUrlError` when they cannot (403) or the
 * agent or drive does not exist (404). The file itself is looked up when the
 * URL is used.
 */
export async function mintSignedDownloadUrl(userId: string, target: SignedDownloadTarget, options: MintOptions = {}): Promise<SignedFileUrl> {
  const ttlMs = lifetime(options)
  const now = options.now ?? Date.now()
  let parsed: SignedDownloadTarget
  try {
    parsed = signedDownloadTargetSchema.parse(
      target.kind === 'workspace-file' ? { ...target, path: normalizeWorkspacePath(target.path) } : target,
    )
  } catch {
    throw new SignedFileUrlError(400, 'Invalid file path')
  }
  if (parsed.kind === 'workspace-file' && parsed.path === '') throw new SignedFileUrlError(400, 'Invalid file path')
  const authorized = await authorizeTarget(await principalFor(userId, now), parsed)
  return mint({ v: SIGNED_FILE_TOKEN_VERSION, jti: newTokenId(), sub: userId, op: 'download', target: authorized, iat: now, exp: now + ttlMs })
}

/**
 * A single-use URL that uploads one file (the PUT body, at most
 * `MAX_UPLOAD_REQUEST_SIZE` bytes) into the agent's `uploads/` for `userId`,
 * who must hold the user role or above on it. `filename` is sanitized now; the
 * stored name gets a timestamp when the bytes arrive. `uploadId` is what
 * `resolveSignedUpload` finds the stored file by.
 */
export async function mintSignedUploadUrl(
  userId: string,
  input: { agentSlug: string; filename: string },
  options: MintOptions = {},
): Promise<SignedFileUrl & { uploadId: string }> {
  const ttlMs = lifetime(options)
  const now = options.now ?? Date.now()
  const uploadId = newTokenId()
  const target = await authorizeTarget(await principalFor(userId, now), {
    kind: 'agent-upload',
    agentSlug: input.agentSlug,
    filename: sanitizeUploadFilename(input.filename).slice(-255),
    uploadId,
  })
  const minted = await mint({ v: SIGNED_FILE_TOKEN_VERSION, jti: newTokenId(), sub: userId, op: 'upload', target, iat: now, exp: now + ttlMs })
  return { ...minted, uploadId }
}

// ---------------------------------------------------------------------------
// Redeeming
// ---------------------------------------------------------------------------

export interface SignedFileGrant<P extends SignedFileTokenPayload = SignedFileTokenPayload> {
  payload: P
  principal: Principal
}

/**
 * The verified token, when it allows `op` and its user still has access to
 * its target now. Throws `SignedFileUrlError`: 401 for a token that is not
 * ours, was changed or has expired, 403 for the wrong operation or access
 * since lost, 404 for an agent or drive that is gone.
 */
export async function authorizeSignedFileRequest<O extends SignedFileOperation>(
  token: string,
  op: O,
  now: number = Date.now(),
): Promise<SignedFileGrant<Extract<SignedFileTokenPayload, { op: O }>>> {
  const verified = await verifyFileToken(token, now)
  if (!verified.ok) throw INVALID_LINK()
  const { payload } = verified
  if (payload.op !== op) throw FORBIDDEN()
  const principal = await principalFor(payload.sub, now)
  await authorizeTarget(principal, payload.target)
  return { payload: payload as Extract<SignedFileTokenPayload, { op: O }>, principal }
}

/** The stream, failed once more than `maxBytes` went through it; `exceeded` says whether that happened. */
function capped(body: ReadableStream<Uint8Array>, maxBytes: number): { body: ReadableStream<Uint8Array>; exceeded: () => boolean } {
  let received = 0
  let over = false
  return {
    body: body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > maxBytes) {
          over = true
          controller.error(new SignedFileUrlError(413, 'File too large'))
          return
        }
        controller.enqueue(chunk)
      },
    })),
    exceeded: () => over,
  }
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() })
}

const TOO_LARGE = () => new SignedFileUrlError(413, `File too large (max ${MAX_UPLOAD_REQUEST_SIZE / 1024 / 1024}MB)`)

/**
 * Writes an upload URL's body into the agent's `uploads/`, once. The same
 * write the upload-file route makes (the actor's `files.write`, nothing left
 * behind on failure). Throws `SignedFileUrlError` 409 while another request
 * holds the URL, 410 once it was used, 413 past `MAX_UPLOAD_REQUEST_SIZE`.
 */
export async function storeSignedUpload(
  grant: SignedFileGrant<Extract<SignedFileTokenPayload, { op: 'upload' }>>,
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number | null,
): Promise<SignedUploadResult & { uploadId: string }> {
  const { payload } = grant
  // Refused from the header alone, before the URL is spent.
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_REQUEST_SIZE) throw TOO_LARGE()

  const claimKey = uploadClaims.key(payload.jti)
  const claim = await appState().insertIfAbsent(claimKey, { state: 'claimed' }, { expiry: { at: payload.exp + CLAIM_GRACE_MS } })
  if (!claim.inserted) {
    throw claim.current.value.state === 'used'
      ? new SignedFileUrlError(410, 'This upload link was already used')
      : new SignedFileUrlError(409, 'This upload link is in use')
  }
  const release = async () => {
    await appState().consume(claimKey, { revision: claim.entry.revision }).catch(() => {})
  }

  const { agentSlug, filename, uploadId } = payload.target
  const files = agentRegistry.get(agentSlug).files
  let uploadPath: string
  let size: number
  try {
    uploadPath = resolveUploadDestPath(filename)
    const limited = capped(body ?? emptyBody(), MAX_UPLOAD_REQUEST_SIZE)
    try {
      ;({ size } = await files.write(uploadPath, limited.body))
    } catch (error) {
      throw limited.exceeded() ? TOO_LARGE() : error
    }
  } catch (error) {
    await release()
    throw error
  }

  const result: SignedUploadResult = { path: `/workspace/${uploadPath}`, filename, sizeBytes: size }
  try {
    // Spent first: a URL whose file landed is never usable again, even if what follows fails.
    // A claim already gone means the token expired meanwhile, which spends it as well.
    await appState().compareAndSet(claimKey, claim.entry.revision, { state: 'used' }, { expiry: 'keep' })
    await appState().insertIfAbsent(uploadResults.key(payload.sub, agentSlug, uploadId), result)
  } catch (error) {
    await files.delete(uploadPath).catch(() => {})
    throw error
  }
  return { ...result, uploadId }
}

/**
 * Where a completed signed upload was stored, for the user and agent it was
 * minted for; null for another user or agent, an unknown id, or one older
 * than `SIGNED_UPLOAD_RESULT_TTL_MS`. The caller authorizes whatever it then
 * does with the file.
 */
export async function resolveSignedUpload(userId: string, agentSlug: string, uploadId: string): Promise<SignedUploadResult | null> {
  if (!userId || !agentSlug || !uploadId) return null
  const canonical = (await agentCatalog.resolveRecord(agentSlug))?.slug
  if (!canonical) return null
  const entry = await appState().get(uploadResults.key(userId, canonical, uploadId))
  return entry?.value ?? null
}
