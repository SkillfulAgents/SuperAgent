/**
 * GET / HEAD / PUT /api/signed-files/:token: redeems a signed, user-bound file
 * URL (src/shared/lib/signed-file-urls/). There is no session here: the token
 * is the credential, so this router has no Authenticated(). After the token
 * verifies, the bound user's access to the target is checked again, and the
 * work runs as that user (`runWithRequestUser`), as Authenticated() would.
 *
 * The token is never echoed, and nothing here logs the URL. Error reports
 * strip the token from the request URL (error-reporting/sentry-provider.ts).
 */
import { Hono, type Context } from 'hono'
import type { FileOps } from '@shared/lib/agent-actor/types'
import { agentRegistry } from '@shared/lib/agent-actor/registry'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { runWithRequestUser } from '@shared/lib/platform-attribution'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { normalizeXAgentAttachmentPaths } from '@shared/lib/services/x-agent-attachment-service'
import {
  SignedFileUrlError,
  authorizeSignedFileRequest,
  openSignedDrive,
  storeSignedUpload,
  type SignedFileGrant,
  type SignedFileTokenPayload,
} from '@shared/lib/signed-file-urls/signed-file-urls'
import { servedRange } from '@shared/lib/utils/http-range'
import { serveVolumeFile, volumeErrorResponse } from '../lib/volume-file'

const signedFiles = new Hono()

// The URL is the credential: a page or file opened from it must not hand it on as a Referer.
signedFiles.use('*', async (c, next) => {
  c.header('Referrer-Policy', 'no-referrer')
  await next()
})

/** `attachment`, with an ASCII fallback name and the exact one in `filename*`. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** A confined open: a link leading out of the workspace, a directory or nothing at all is not a file this URL serves. */
async function openConfined(files: FileOps, filePath: string, range?: { start: number; end: number }) {
  try {
    return await files.readSized(filePath, { confined: true, ...(range ? { range } : {}) })
  } catch (error) {
    if (error instanceof WorkspaceFileError) return null
    throw error
  }
}

/**
 * A workspace file as an attachment, with Range support: the headers the
 * workspace and drive file routes set, never inline. The size and the bytes
 * come from one confined open (`readSized`), as `/api/x-agent/download-file`
 * reads them, so the file cannot be swapped for a link between a check and
 * the read. `expectedSize` refuses a delivered file that changed after it
 * was delivered (409).
 */
async function serveWorkspaceFile(
  c: Context,
  files: FileOps,
  filePath: string,
  filename: string,
  expectedSize?: number,
): Promise<Response> {
  const opened = await openConfined(files, filePath)
  if (!opened) return c.json({ error: 'File not found' }, 404)
  const { size } = opened
  const discard = () => opened.stream.cancel().catch(() => {})
  if (expectedSize !== undefined && size !== expectedSize) {
    await discard()
    return c.json({ error: 'File changed after it was delivered' }, 409)
  }

  c.header('Content-Disposition', attachmentDisposition(filename))
  c.header('Content-Type', 'application/octet-stream')
  c.header('Cache-Control', 'private, no-store, max-age=0')
  c.header('X-Content-Type-Options', 'nosniff')
  // User files must never execute as the app's origin, including when opened in a new tab.
  c.header('Content-Security-Policy', 'sandbox allow-scripts')

  const served = servedRange(c.req.header('range'), size)
  // A HEAD runs this GET handler: the headers are the whole answer, and the open is released unread.
  if (served.status === 416 || c.req.method === 'HEAD') {
    await discard()
    return c.body(null, served.status, served.headers)
  }
  if (!served.range) return c.body(opened.stream, served.status, served.headers)

  // A slice is read from a second confined open; a size that moved in between means the file changed.
  await discard()
  const slice = await openConfined(files, filePath, served.range)
  if (!slice) return c.json({ error: 'File not found' }, 404)
  if (slice.size !== size) {
    await slice.stream.cancel().catch(() => {})
    return c.json({ error: 'File changed while being read' }, 409)
  }
  return c.body(slice.stream, served.status, served.headers)
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1)
}

async function serveDownload(c: Context, grant: SignedFileGrant<Extract<SignedFileTokenPayload, { op: 'download' }>>): Promise<Response> {
  const { target } = grant.payload
  switch (target.kind) {
    case 'workspace-file': {
      return serveWorkspaceFile(c, agentRegistry.get(target.agentSlug).files, target.path, basename(target.path))
    }
    case 'delivered-file': {
      const actor = agentRegistry.get(target.agentSlug)
      if (!(await actor.sessions.isKnown(target.sessionId))) return c.json({ error: 'File not found' }, 404)
      const delivery = await actor.messages.findDeliveredFile(target.sessionId, target.deliveryId)
      if (!delivery) return c.json({ error: 'File not found' }, 404)
      let sourcePath: string
      try {
        [sourcePath] = normalizeXAgentAttachmentPaths([delivery.filePath])
      } catch {
        return c.json({ error: 'File not found' }, 404)
      }
      return serveWorkspaceFile(c, actor.files, sourcePath, delivery.filename, delivery.sizeBytes)
    }
    case 'drive-file': {
      const volume = await openSignedDrive(grant.principal, target.volumeId)
      return serveVolumeFile(c, volume, target.path, { attachmentOnly: true })
    }
  }
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof SignedFileUrlError) return c.json({ error: error.message }, error.status)
  if (error instanceof WorkspaceFileError) {
    return error.status === 404 ? c.json({ error: 'File not found' }, 404) : c.json({ error: 'Invalid path' }, error.status)
  }
  const known = volumeErrorResponse(c, error)
  if (known) return known
  // The error only: the request URL holds the token.
  console.error('[signed-files] Request failed:', error)
  return c.json({ error: 'Failed to transfer file' }, 500)
}

// GET (and HEAD) /api/signed-files/:token - download the one file the token names
signedFiles.get('/:token', async (c) => {
  try {
    const grant = await authorizeSignedFileRequest(c.req.param('token'), 'download')
    return await runWithRequestUser(grant.payload.sub, () => serveDownload(c, grant))
  } catch (error) {
    return failure(c, error)
  }
})

// PUT /api/signed-files/:token - the raw body is the file, written once into the agent's uploads/
signedFiles.put('/:token', async (c) => {
  try {
    const grant = await authorizeSignedFileRequest(c.req.param('token'), 'upload')
    const declared = c.req.header('content-length')
    const declaredLength = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null
    const stored = await runWithRequestUser(grant.payload.sub, () => storeSignedUpload(grant, c.req.raw.body, declaredLength))
    const { agentSlug } = grant.payload.target
    await logAuditEvent({ userId: grant.payload.sub, object: 'file', objectId: `${agentSlug}/${stored.filename}`, action: 'uploaded' })
    return c.json({ uploadId: stored.uploadId, filename: stored.filename, size: stored.sizeBytes }, 201)
  } catch (error) {
    return failure(c, error)
  }
})

export default signedFiles
