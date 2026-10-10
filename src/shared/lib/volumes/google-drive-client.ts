import { randomUUID } from 'node:crypto'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { DRIVE_FILE_FIELDS, driveErrorSchema, driveFileSchema, type DriveFile } from './google-drive-schema'
import { getAccountProviderByName } from '@shared/lib/account-providers/provider-factory'
import { writeProxyAuditEntry } from '@shared/lib/proxy/audit'
import { requireAccount, withRemoteAccount, withRemoteAttribution } from './remote-account'
import { uploadChunks, throwIfUploadAborted } from './remote-transfer'
import { VolumeError } from './volume-error'
import { RemoteRequestPacer, retryAfterSeconds } from './remote-request-pacer'

const HOST = 'www.googleapis.com'
/** Composio's proxy refuses bodies from 768 KiB; Drive wants multiples of 256 KiB. */
export const UPLOAD_CHUNK_BYTES = 512 * 1024
const RATE_LIMIT_REASONS = ['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded']

export function requireGoogleDriveAccount(accountId: string, creator?: { userId: string | null }) {
  return requireAccount(accountId, 'googledrive', creator)
}

export function withGoogleDriveAccount<T>(accountId: string, run: (account: Awaited<ReturnType<typeof requireGoogleDriveAccount>>) => Promise<T>, refresh = false): Promise<T> {
  return withRemoteAccount(accountId, 'googledrive', run, refresh)
}
const unavailable = (status: 429 | 503, delay?: number) => new VolumeError(status === 429
  ? 'Google Drive is busy. Please try again shortly.' : 'Google Drive is temporarily unavailable. Please try again.', status, delay)
const pacer = new RemoteRequestPacer(unavailable)

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
  if (response.status === 403 || response.status === 429) throw unavailable(429, retryAfterSeconds(response))
  if (response.status === 409 || response.status === 412) throw new VolumeError('The file changed in Google Drive during the operation.', 409)
  throw unavailable(503)
}

/** Shared pacing, operation-scoped attribution and one audit row per published request. */
export async function driveRequest(accountId: string, request: DriveRequest, options: { agentSlug?: string; staging?: boolean; signal?: AbortSignal } = {}): Promise<Response> {
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
    return await withRemoteAttribution(accountId, 'googledrive', account => pacer.run(accountId, request.method === 'GET', async () => {
      let response: Response
      try {
        response = await getAccountProviderByName(account.providerName).makeApiCall({
          providerConnectionId: account.providerConnectionId, toolkitSlug: 'googledrive', targetUrl: url.toString(), method: request.method, headers, body,
        })
      } catch { throw unavailable(503) }
      statusCode = response.status
      if (!response.ok && response.status !== 308) return throwDriveError(response)
      return response
    }, options.signal))
  } finally {
    // Like Dropbox, only published changes join the agent's audit trail: reads, upload
    // sessions and staged chunks are implementation traffic, and never product analytics.
    const published = request.method !== 'GET' && !options.staging && statusCode !== 308 && !(url.searchParams.get('uploadType') === 'resumable' && request.method !== 'PUT')
    if (options.agentSlug && published) await writeProxyAuditEntry({
      agentSlug: options.agentSlug, accountId, toolkit: 'googledrive', targetHost: HOST, targetPath: url.pathname.slice(1), method: request.method,
      statusCode, durationMs: Date.now() - start, policyDecision: 'allow',
      ...(statusCode === undefined || statusCode >= 400 ? { errorMessage: statusCode ? `Upstream returned ${statusCode}` : 'Google Drive volume request failed' } : {}),
    }, { analytics: false })
  }
}

/** A small upload carries metadata and bytes in one multipart request. Larger
 * files stage 512 KiB chunks, holding back the final chunk until publication is
 * authorized. Both paths finish reading/validating the body before publication. */
export async function driveUpload(
  accountId: string, session: { method: 'POST' | 'PATCH'; path: string; json: unknown; contentType?: string },
  body: ReadableStream<Uint8Array>,
  options: { agentSlug?: string; signal?: AbortSignal; publish?: (send: () => Promise<DriveFile>) => Promise<DriveFile> } = {},
): Promise<DriveFile> {
  const { contentType, ...open } = session
  const chunks = uploadChunks(body, UPLOAD_CHUNK_BYTES, options.signal)
  const publish = options.publish ?? (send => send())
  const stored = async (response: Response, total: number) => {
    if (response.status === 308) throw unavailable(503)
    const file = driveFileSchema.parse(await response.json())
    if (!contentType && file.size !== total) throw new VolumeError(`Google Drive stored ${file.size} of ${total} bytes`, 503)
    return file
  }
  try {
    const first = await chunks.next()
    let next = await chunks.next()
    if (next.done) {
      const bytes = first.value ?? new ArrayBuffer(0)
      const boundary = `gamut_${randomUUID()}`
      const multipart = new Uint8Array(Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(open.json)}\r\n--${boundary}\r\nContent-Type: ${contentType ?? 'application/octet-stream'}\r\n\r\n`),
        Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`),
      ])).buffer
      throwIfUploadAborted(options.signal)
      return await publish(async () => {
        throwIfUploadAborted(options.signal)
        return stored(await driveRequest(accountId, {
          method: open.method, path: open.path, bytes: multipart,
          query: { uploadType: 'multipart', fields: DRIVE_FILE_FIELDS }, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        }, { agentSlug: options.agentSlug, signal: options.signal }), bytes.byteLength)
      })
    }
    throwIfUploadAborted(options.signal)
    const opened = await driveRequest(accountId, {
      ...open, query: { uploadType: 'resumable', fields: DRIVE_FILE_FIELDS }, ...(contentType ? { headers: { 'X-Upload-Content-Type': contentType } } : {}),
    }, { agentSlug: options.agentSlug, staging: true, signal: options.signal })
    await opened.body?.cancel()
    const location = opened.headers.get('location')
    if (!location) throw unavailable(503)
    const put = async (bytes: ArrayBuffer, range: string, staging = false) => {
      throwIfUploadAborted(options.signal)
      return driveRequest(accountId, { method: 'PUT', path: location, bytes,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': range },
      }, { agentSlug: options.agentSlug, staging, signal: options.signal })
    }
    let offset = 0
    let last = first.value!
    while (!next.done) {
      await (await put(last, `bytes ${offset}-${offset + last.byteLength - 1}/*`, true)).body?.cancel()
      offset += last.byteLength
      last = next.value
      next = await chunks.next()
    }
    const total = offset + last.byteLength
    throwIfUploadAborted(options.signal)
    return await publish(async () => stored(await put(last, `bytes ${offset}-${total - 1}/${total}`), total))
  } finally { await chunks.return(undefined) }
}
