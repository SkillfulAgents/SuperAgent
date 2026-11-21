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
 * An upload URL is single use, through one AppState record per upload
 * (`signed-file:upload`, keyed by user, agent and upload id):
 * - minting writes it `pending` (`insertIfAbsent`), until the token's expiry;
 * - a PUT moves `pending` -> `claimed` (compare-and-set) before any byte is
 *   written, so of concurrent PUTs one proceeds and the rest get 409;
 * - a write that fails moves it back to `pending`, so the URL can be retried
 *   while it is valid;
 * - a write that landed moves `claimed` -> `completed` in ONE compare-and-set
 *   that both spends the URL and stores where the file went, for
 *   `SIGNED_UPLOAD_RESULT_TTL_MS`. If that step does not land, the file this
 *   request wrote is removed (confined) and the URL is handed back.
 * An absent record is never usable: an expired URL, or one minted before a
 * restart, is refused. `resolveSignedUpload` reads only a `completed` record,
 * for that user and agent, while that user may still use the agent. The
 * write is confined and exclusive, to a name that carries the upload id.
 *
 * Known limits, accepted for now:
 * - An upload is one request of at most `MAX_UPLOAD_REQUEST_SIZE` (64MB).
 *   There is no chunking: a file over 64MB has no signed upload path yet.
 *   Chunked signed uploads (up to the 2GB total) are tracked in SUP-1772.
 * - The records live in AppState, which is process memory on desktop and
 *   single-tenant web (LocalAppState). A restart drops pending uploads (their
 *   URLs are refused from then on) and completed results (`resolveSignedUpload`
 *   returns null for an upload that succeeded before it); it never re-enables
 *   a used URL.
 * - A download URL can be used any number of times until it expires.
 */
import { eq } from 'drizzle-orm'
import { appState, defineNamespace } from '@shared/lib/app-state'
import { getAppBaseUrl } from '@shared/lib/auth/config'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
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
  MAX_SIGNED_UPLOAD_FILENAME_LENGTH,
  SIGNED_FILE_CLOCK_SKEW_MS,
  SIGNED_FILE_TOKEN_VERSION,
  SIGNED_UPLOAD_RESULT_TTL_MS,
  signedDownloadTargetSchema,
  signedUploadRecordSchema,
  type AgentUploadTarget,
  type SignedDownloadTarget,
  type SignedFileOperation,
  type SignedFileTokenPayload,
  type SignedUploadRecord,
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

/**
 * How long a claimed upload may take to write its bytes. A claim held past it
 * (its process went away mid-write) expires, and the URL with it: it fails
 * closed. A completion after it does not land, and its file is removed.
 */
const UPLOAD_WRITE_WINDOW_MS = 15 * 60_000

const uploads = defineNamespace({
  name: 'signed-file:upload',
  consistency: 'strong',
  schema: signedUploadRecordSchema,
  // Every write names its expiry; this is the backstop.
  expiry: { ttlMs: MAX_SIGNED_FILE_URL_TTL_MS + SIGNED_FILE_CLOCK_SKEW_MS, onUpdate: 'keep' },
})

function uploadKey(userId: string, agentSlug: string, uploadId: string) {
  return uploads.key(userId, agentSlug, uploadId)
}

/** A pending upload lives until its token expires, plus the margin another process's clock may need. */
function pendingExpiry(payload: { exp: number }) {
  return { at: payload.exp + SIGNED_FILE_CLOCK_SKEW_MS }
}

/**
 * A refusal, with the HTTP status the redeeming route answers it with. The
 * message is short and says nothing about why beyond what the status does.
 */
export class SignedFileUrlError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 500,
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

/**
 * Where the URL's holder reaches this app: the configured public address
 * (`HOST_PUBLIC_URL`, then the first trusted origin), as the other links the
 * app hands outside use, else the address it is bound to.
 */
async function signedFilesBaseUrl(): Promise<string> {
  return (await resolvePublicAppBaseUrl()) ?? (await getAppBaseUrl())
}

async function mint(payload: SignedFileTokenPayload): Promise<SignedFileUrl> {
  const token = await signFileToken(payload)
  return { url: `${await signedFilesBaseUrl()}${SIGNED_FILES_ROUTE_PREFIX}/${token}`, expiresAt: new Date(payload.exp) }
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
  const now = Date.now()
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
 * who must hold the user role or above on it. `filename` is sanitized now,
 * and shortened so that it still fits a file name once the timestamp is added
 * when the bytes arrive. `uploadId` is what
 * `resolveSignedUpload` finds the stored file by.
 */
export async function mintSignedUploadUrl(
  userId: string,
  input: { agentSlug: string; filename: string },
  options: MintOptions = {},
): Promise<SignedFileUrl & { uploadId: string }> {
  const ttlMs = lifetime(options)
  const now = Date.now()
  const uploadId = newTokenId()
  const target = await authorizeTarget(await principalFor(userId, now), {
    kind: 'agent-upload',
    agentSlug: input.agentSlug,
    filename: fitStoredUploadName(sanitizeUploadFilename(input.filename)),
    uploadId,
  })
  const payload: SignedFileTokenPayload = { v: SIGNED_FILE_TOKEN_VERSION, jti: newTokenId(), sub: userId, op: 'upload', target, iat: now, exp: now + ttlMs }
  // The record a PUT must find: without it the URL is refused.
  const registered = await appState().insertIfAbsent(uploadKey(userId, target.agentSlug, uploadId), { state: 'pending', jti: payload.jti }, { expiry: pendingExpiry(payload) })
  if (!registered.inserted) throw new Error('Upload id collision')
  const minted = await mint(payload)
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
): Promise<SignedFileGrant<Extract<SignedFileTokenPayload, { op: O }>>> {
  const now = Date.now()
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

/** A sanitized (ASCII) name, cut so the stored name (upload id and timestamp added) fits NAME_MAX, its extension kept. */
export function fitStoredUploadName(name: string): string {
  const max = MAX_SIGNED_UPLOAD_FILENAME_LENGTH
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  return `${name.slice(0, max - extension.length)}${extension}`
}

const TOO_LARGE = () => new SignedFileUrlError(413, `File too large (max ${MAX_UPLOAD_REQUEST_SIZE / 1024 / 1024}MB)`)

/** `name` with `-<upload id>` before its extension, so no two uploads share a destination. */
function withUploadId(name: string, uploadId: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}-${uploadId}`
  return `${name.slice(0, dot)}-${uploadId}${name.slice(dot)}`
}

const UPLOAD_FAILED = () => new SignedFileUrlError(500, 'Upload failed')

/** Why an upload record that is not `pending` (or is gone) refuses a PUT. */
function notPending(record: SignedUploadRecord | null, jti: string): SignedFileUrlError {
  if (!record || record.jti !== jti) return new SignedFileUrlError(410, 'This upload link is no longer valid')
  if (record.state === 'completed') return new SignedFileUrlError(410, 'This upload link was already used')
  return new SignedFileUrlError(409, 'This upload link is in use')
}

/**
 * Writes an upload URL's body into the agent's `uploads/`, once: the actor's
 * `files.write`, confined (a link leading out of the workspace is refused)
 * and exclusive, to `<name>-<upload id>-<timestamp>.<ext>`, nothing left
 * behind on failure. Throws `SignedFileUrlError` 409 while another request
 * holds the URL, 410 once it was used or when its record is gone (expired,
 * or minted before a restart), 413 past `MAX_UPLOAD_REQUEST_SIZE`, 500 when
 * the file could not be stored (the cause is logged, not answered; the URL
 * can be retried while it is valid).
 */
export async function storeSignedUpload(
  grant: SignedFileGrant<Extract<SignedFileTokenPayload, { op: 'upload' }>>,
  body: ReadableStream<Uint8Array> | null,
  declaredLength: number | null,
): Promise<SignedUploadResult & { uploadId: string }> {
  const { payload } = grant
  // Refused from the header alone, before the URL is claimed.
  if (declaredLength !== null && declaredLength > MAX_UPLOAD_REQUEST_SIZE) throw TOO_LARGE()

  const { agentSlug, filename, uploadId } = payload.target
  const key = uploadKey(payload.sub, agentSlug, uploadId)
  // pending -> claimed is a compare-and-set against the revision read: of concurrent PUTs one wins.
  const current = await appState().get(key)
  if (!current || current.value.state !== 'pending' || current.value.jti !== payload.jti) throw notPending(current?.value ?? null, payload.jti)
  const claim = await appState().compareAndSet(key, current.revision, { state: 'claimed', jti: payload.jti }, {
    expiry: { at: Math.max(payload.exp + SIGNED_FILE_CLOCK_SKEW_MS, Date.now() + UPLOAD_WRITE_WINDOW_MS) },
  })
  if (!claim.ok) throw notPending(claim.current?.value ?? null, payload.jti)

  /** Hands the URL back after a failure: claimed -> pending while the token is valid, else gone. */
  const release = async () => {
    try {
      if (Date.now() < payload.exp) {
        await appState().compareAndSet(key, claim.entry.revision, { state: 'pending', jti: payload.jti }, { expiry: pendingExpiry(payload) })
      } else {
        await appState().consume(key, { revision: claim.entry.revision })
      }
    } catch (error) {
      // The claim then runs out by itself; the URL fails closed.
      console.error('[signed-files] Could not release an upload claim:', error)
    }
  }

  const files = agentRegistry.get(agentSlug).files
  let uploadPath: string
  let size: number
  try {
    uploadPath = resolveUploadDestPath(withUploadId(filename, uploadId))
    const limited = capped(body ?? emptyBody(), MAX_UPLOAD_REQUEST_SIZE)
    try {
      ;({ size } = await files.write(uploadPath, limited.body, { confined: true, overwrite: false }))
    } catch (error) {
      if (limited.exceeded()) throw TOO_LARGE()
      console.error('[signed-files] Upload write failed:', error)
      throw UPLOAD_FAILED()
    }
  } catch (error) {
    await release()
    throw error
  }

  // This request created the file at uploadPath (the write was exclusive). One
  // compare-and-set both spends the URL and records where the file went.
  const result: SignedUploadResult = { path: `/workspace/${uploadPath}`, filename, sizeBytes: size }
  const completed: SignedUploadRecord = { state: 'completed', jti: payload.jti, result }
  let landed: boolean
  try {
    landed = (await appState().compareAndSet(key, claim.entry.revision, completed, { expiry: { ttlMs: SIGNED_UPLOAD_RESULT_TTL_MS } })).ok
  } catch (error) {
    // The answer was lost: the stored record says whether the write landed.
    console.error('[signed-files] Upload completion failed:', error)
    landed = await appState().get(key).then(
      (entry) => entry?.value.state === 'completed' && entry.value.result.path === result.path,
      () => false,
    )
  }
  if (!landed) {
    // Never a spent URL with nothing behind it: remove the file this request
    // created (confined, so a link swapped in meanwhile is refused, never
    // followed) and hand the URL back.
    await files.delete(uploadPath, { confined: true }).catch((error) => {
      console.error('[signed-files] Could not remove an upload that did not complete:', error)
    })
    await release()
    throw UPLOAD_FAILED()
  }
  return { ...result, uploadId }
}

/**
 * Where a completed signed upload was stored, for the user and agent it was
 * minted for, checked again as a redeem is: the account still active and
 * still holding the user role or above on the agent. Null for another user
 * or agent, access since lost, an unknown id, or one older than
 * `SIGNED_UPLOAD_RESULT_TTL_MS` (or from before a restart, see above).
 */
export async function resolveSignedUpload(userId: string, agentSlug: string, uploadId: string): Promise<SignedUploadResult | null> {
  if (!userId || !agentSlug || !uploadId) return null
  let canonical: string
  try {
    canonical = await requireAgentRole(await principalFor(userId, Date.now()), agentSlug, 'user')
  } catch (error) {
    if (error instanceof SignedFileUrlError) return null
    throw error
  }
  const entry = await appState().get(uploadKey(userId, canonical, uploadId))
  return entry?.value.state === 'completed' ? entry.value.result : null
}
