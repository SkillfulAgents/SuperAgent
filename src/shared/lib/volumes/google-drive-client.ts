import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { DRIVE_FILE_FIELDS, driveErrorSchema, driveFileSchema, type DriveFile } from './google-drive-schema'
import { getAccountProviderByName } from '@shared/lib/account-providers/provider-factory'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { writeProxyAuditEntry } from '@shared/lib/proxy/audit'
import { requireAccount } from './remote-account'
import { uploadChunks } from './remote-transfer'
import { withRetry } from '@shared/lib/utils/retry'

const HOST = 'www.googleapis.com'
/** Composio's proxy refuses bodies from 768 KiB; Drive wants multiples of 256 KiB. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024
const RATE_LIMIT_REASONS = ['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded']

export function requireGoogleDriveAccount(accountId: string, creator?: { userId: string | null }) {
  return requireAccount(accountId, 'googledrive', creator)
}

/** An upstream failure: a read may be retried, a change never is, since it may have been applied. */
class DriveRetryableError extends Error {}

/** Drive refused the request for a rate limit without applying it, so any request may be retried. */
class DriveRateLimitError extends DriveRetryableError {}

/** Drive refuses to export a Google file whose export would exceed 10 MB. */
export class DriveExportTooLargeError extends Error {
  constructor() {
    super('Google Drive export exceeds 10 MB')
    this.name = 'DriveExportTooLargeError'
  }
}

export interface DriveRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  /** Relative to the API host, or an upload session URL on it. */
  path: string
  query?: Record<string, string>
  json?: unknown
  bytes?: ArrayBuffer
  headers?: Record<string, string>
}

function urlOf(request: DriveRequest): URL {
  const url = URL.parse(request.path, `https://${HOST}/`)
  if (url?.protocol !== 'https:' || url.hostname !== HOST) throw new Error(`Google Drive request is not on ${HOST}`)
  url.searchParams.set('supportsAllDrives', 'true')
  for (const [name, value] of Object.entries(request.query ?? {})) url.searchParams.set(name, value)
  return url
}

async function throwDriveError(response: Response): Promise<never> {
  const parsed = driveErrorSchema.safeParse(await response.json().catch(() => null))
  const reasons = parsed.success ? (parsed.data.error?.errors ?? []).map(error => error.reason) : []
  if (response.status === 404) throw new WorkspaceFileError('not-found')
  if (response.status === 403 && reasons.includes('exportSizeLimitExceeded')) throw new DriveExportTooLargeError()
  if (response.status === 401 || (response.status === 403 && !reasons.some(reason => reason && RATE_LIMIT_REASONS.includes(reason)))) {
    throw new WorkspaceFileError('not-accessible', 'Google Drive access is unavailable. Check the account connection and folder permissions.')
  }
  const failure = `Google Drive request failed (${response.status})`
  if (response.status === 403 || response.status === 429) throw new DriveRateLimitError(failure)
  throw response.status >= 500 ? new DriveRetryableError(failure) : new Error(failure)
}

/** Only the volume driver calls this; every request stays on the API host. A request refused for a
 * rate limit, or a read that hits an upstream failure, is tried three times, a second then two seconds apart. */
export function driveRequest(accountId: string, request: DriveRequest, options: { agentSlug?: string } = {}): Promise<Response> {
  const retryable = request.method === 'GET' ? DriveRetryableError : DriveRateLimitError
  return withRetry(() => driveRequestOnce(accountId, request, options), 3, 1000, error => error instanceof retryable)
}

async function driveRequestOnce(accountId: string, request: DriveRequest, options: { agentSlug?: string }): Promise<Response> {
  const url = urlOf(request)
  const headers = new Headers(request.headers)
  let body: ArrayBuffer | null = request.bytes ?? null
  if (request.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = new TextEncoder().encode(JSON.stringify(request.json)).buffer
  }
  const start = Date.now()
  let statusCode: number | undefined
  try {
    // Re-read on each request: deleting or revoking an account revokes its mounts too.
    const account = await requireGoogleDriveAccount(accountId)
    const response = await runWithAttribution(await attribution.fromResourceCreator(account.userId), () =>
      getAccountProviderByName(account.providerName).makeApiCall({
        providerConnectionId: account.providerConnectionId, toolkitSlug: 'googledrive', targetUrl: url.toString(), method: request.method, headers, body,
      }))
    statusCode = response.status
    // 308 is a resumable upload acknowledging a chunk.
    if (!response.ok && response.status !== 308) return await throwDriveError(response)
    return response
  } finally {
    // Like Dropbox, only published changes join the agent's audit trail: reads, upload
    // sessions and staged chunks are implementation traffic, and never product analytics.
    const published = request.method !== 'GET' && statusCode !== 308 && !(url.pathname.startsWith('/upload/') && request.method !== 'PUT')
    if (options.agentSlug && published) await writeProxyAuditEntry({
      agentSlug: options.agentSlug, accountId, toolkit: 'googledrive', targetHost: HOST, targetPath: url.pathname.slice(1), method: request.method,
      statusCode, durationMs: Date.now() - start, policyDecision: 'allow',
      ...(statusCode === undefined || statusCode >= 400 ? { errorMessage: statusCode ? `Upstream returned ${statusCode}` : 'Google Drive volume request failed' } : {}),
    }, { analytics: false })
  }
}

/** A resumable upload: open a session, then send the body in chunks, the last one carrying the total.
 * Sending the last chunk makes the change, and `publish` wraps that step alone, so a caller can check
 * and serialize it without holding anything across the upload. An empty body is one empty request.
 * Resolves to the file as stored. */
export async function driveUpload(
  accountId: string, session: { method: 'POST' | 'PATCH'; path: string; json: unknown; contentType?: string },
  body: ReadableStream<Uint8Array>,
  options: { agentSlug?: string; signal?: AbortSignal; publish?: (send: () => Promise<DriveFile>) => Promise<DriveFile> } = {},
): Promise<DriveFile> {
  // Naming the content type of a copy makes Drive convert it back into the Google file.
  const { contentType, ...open } = session
  const opened = await driveRequest(accountId, {
    ...open, query: { uploadType: 'resumable', fields: DRIVE_FILE_FIELDS }, ...(contentType ? { headers: { 'X-Upload-Content-Type': contentType } } : {}),
  }, { agentSlug: options.agentSlug })
  await opened.body?.cancel()
  const location = opened.headers.get('location')
  if (!location) throw new Error('Google Drive returned no upload session')
  const put = async (bytes: ArrayBuffer, range?: string) => {
    // A caller that gave up (rclone cancels an upload when the file is renamed or the mount stops)
    // must not see the upload finish later: Drive discards a session that is never completed.
    if (options.signal?.aborted) throw new Error('Upload cancelled by the client')
    const response = await driveRequest(accountId, {
      method: 'PUT', path: location, bytes, headers: { 'Content-Type': 'application/octet-stream', ...(range ? { 'Content-Range': range } : {}) },
    }, { agentSlug: options.agentSlug })
    return response
  }
  let offset = 0
  let last: ArrayBuffer | undefined
  // Hold one chunk back, so the last one is known to be last.
  for await (const bytes of uploadChunks(body, UPLOAD_CHUNK_BYTES)) {
    if (last) {
      await (await put(last, `bytes ${offset}-${offset + last.byteLength - 1}/*`)).body?.cancel()
      offset += last.byteLength
    }
    last = bytes
  }
  const total = offset + (last?.byteLength ?? 0)
  const publish = options.publish ?? (send => send())
  // A cancelled upload never waits for the change it would have made.
  if (options.signal?.aborted) throw new Error('Upload cancelled by the client')
  return publish(async () => {
    const done = last ? await put(last, `bytes ${offset}-${total - 1}/${total}`) : await put(new ArrayBuffer(0))
    if (done.status === 308) throw new Error('Google Drive did not complete the upload')
    // A converted file is stored in Google's form, so only a plain file's stored size must match what was sent.
    const stored = driveFileSchema.parse(await done.json())
    if (!contentType && stored.size !== undefined && stored.size !== total) throw new Error(`Google Drive stored ${stored.size} of ${total} bytes`)
    return stored
  })
}
