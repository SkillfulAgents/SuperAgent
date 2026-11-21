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

/** `attachment`, with an ASCII fallback name and the exact one in `filename*`. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * A workspace file as an attachment, with Range support: the headers the
 * workspace and drive file routes set, never inline. `expectedSize` refuses a
 * delivered file that changed after it was delivered (409), as
 * `/api/x-agent/download-file` does.
 */
async function serveWorkspaceFile(
  c: Context,
  files: FileOps,
  filePath: string,
  filename: string,
  expectedSize?: number,
): Promise<Response> {
  // Served by its real location, as the files route does: a link that leaves the workspace is refused.
  const resolved = await files.resolve(filePath)
  const stat = resolved === null ? null : await files.stat(resolved)
  if (resolved === null || !stat || stat.kind !== 'file') return c.json({ error: 'File not found' }, 404)
  if (expectedSize !== undefined && stat.size !== expectedSize) {
    return c.json({ error: 'File changed after it was delivered' }, 409)
  }

  c.header('Content-Disposition', attachmentDisposition(filename))
  c.header('Content-Type', 'application/octet-stream')
  c.header('Cache-Control', 'private, no-store, max-age=0')
  c.header('X-Content-Type-Options', 'nosniff')
  // User files must never execute as the app's origin, including when opened in a new tab.
  c.header('Content-Security-Policy', 'sandbox allow-scripts')

  const served = servedRange(c.req.header('range'), stat.size)
  // A HEAD runs this GET handler: answer with the headers before opening the file (see the files route).
  if (served.status === 416 || c.req.method === 'HEAD') return c.body(null, served.status, served.headers)
  return c.body(await files.read(resolved, served.range ?? undefined), served.status, served.headers)
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
