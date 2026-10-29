import type { Context } from 'hono'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { servedRange } from '@shared/lib/utils/http-range'
import { guessMimeType } from '@shared/lib/utils/mime'
import type { BaseMountableVolume } from '@shared/lib/volumes/base-mountable-volume'
import { VolumeError } from '@shared/lib/volumes/volume-error'

/** A drive file's bytes, served by every route that reads a drive for a person. */
export async function serveVolumeFile(c: Context, volume: BaseMountableVolume<unknown>, path: string): Promise<Response> {
  if (!path) return c.json({ error: 'File path is required' }, 400)
  const file = await volume.read(path)
  try {
    const served = servedRange(c.req.header('range'), file.size)
    const inline = c.req.query('inline') === 'true'
    const name = path.slice(path.lastIndexOf('/') + 1)
    const encoded = encodeURIComponent(name)
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encoded}"; filename*=UTF-8''${encoded}`)
    c.header('Content-Type', inline ? guessMimeType(name) : 'application/octet-stream')
    c.header('Cache-Control', 'private, no-store, max-age=0')
    c.header('X-Content-Type-Options', 'nosniff')
    // User files must never execute as the app's origin, including when opened in a new tab.
    c.header('Content-Security-Policy', 'sandbox allow-scripts')
    const range = served.range ?? (file.size > 0 ? { start: 0, end: file.size - 1 } : null)
    if (served.status === 416 || c.req.method === 'HEAD' || !range) {
      await file.close()
      return c.body(null, served.status, served.headers)
    }
    return c.body(await file.stream(range), served.status, served.headers)
  } catch (error) {
    await file.close()
    throw error
  }
}

/** The answer for a drive's own failure, or null for an error that is not one. */
export function volumeErrorResponse(c: Context, error: unknown): Response | null {
  if (error instanceof VolumeError) {
    if (error.retryAfter !== undefined) c.header('Retry-After', String(error.retryAfter))
    return c.json({ error: error.message }, error.status)
  }
  if (error instanceof WorkspaceFileError) return c.json({ error: error.message }, error.status)
  return null
}

/** The answer for any failure reading a drive: its own status, else unavailable. */
export function volumeFailure(c: Context, error: unknown): Response {
  const known = volumeErrorResponse(c, error)
  if (known) return known
  console.error('[volumes] Drive read failed:', error)
  return c.json({ error: 'This drive is unavailable. Please try again.' }, 503)
}
