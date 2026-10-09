import { Hono, type Context } from 'hono'
import { IsAgent } from '../middleware/auth'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { DropboxUnavailableError } from '@shared/lib/volumes/dropbox-error'
import { servedRange } from '@shared/lib/utils/http-range'
import { resolveVolume } from '@shared/lib/services/mount-service'
import { depthOf, destinationOf, multistatus, statusOf, volumePathOf } from '@shared/lib/volumes/webdav'
import type { HttpBindings } from '@hono/node-server'
import { allowStreamingUpload } from '@shared/lib/streaming-upload-timeout'

const RCLONE_FIRST_CHUNK_BYTES = 128 * 1024 * 1024

type Env = { Variables: { agentSlug: string }; Bindings: HttpBindings }

const volumes = new Hono<Env>()

// The URL id names an attachment. The agent token and attachment must match;
// a definition being public never grants an unattached agent WebDAV access.
volumes.use('*', IsAgent())

async function serve(c: Context<Env>, volumeId: string): Promise<Response> {
  const base = `/api/volumes/${volumeId}`
  // A volume that is not this agent's answers 403, never 404: rclone would show a 404 root as an empty folder.
  const ops = await resolveVolume(c.get('agentSlug'), volumeId)
  if (!ops) return c.body(null, 403)

  let path = ''
  try {
    // The raw path, as the agent files route reads it: Hono's c.req.path is already decoded.
    path = volumePathOf(new URL(c.req.url).pathname, base)
    switch (c.req.method) {
      case 'PROPFIND': {
        const depth = depthOf(c.req.header('depth'))
        const entry = await ops.stat(path)
        const children = depth === 1 && entry.kind === 'directory' ? await ops.list(path) : []
        const items = [
          { path, entry },
          ...children.map((child) => ({ path: path === '' ? child.name : `${path}/${child.name}`, entry: child })),
        ]
        return c.body(multistatus(base, items), 207, { 'Content-Type': 'application/xml; charset=utf-8' })
      }
      case 'GET':
      case 'HEAD': {
        const file = await ops.read(path)
        const served = servedRange(c.req.header('range'), file.size)
        // rclone ends every range at the size it last listed (fs.FixRangeOption) and reads in 128 MiB pieces or more,
        // so a range ending short of a smaller file's end means that size is stale: serving it would cut the file.
        if (served.range && served.range.end < file.size - 1 && served.range.end + 1 < RCLONE_FIRST_CHUNK_BYTES) {
          await file.close()
          return c.body(null, 416, { 'Content-Range': `bytes */${file.size}` })
        }
        // A whole-file answer stops at the size it advertised, so a file growing mid-read cannot overrun it.
        const range = served.range ?? (file.size > 0 ? { start: 0, end: file.size - 1 } : null)
        if (served.status === 416 || c.req.method === 'HEAD' || !range) {
          await file.close()
          return c.body(null, served.status, served.headers)
        }
        return c.body(await file.stream(range), served.status, served.headers)
      }
      case 'PUT':
        allowStreamingUpload(c.env?.incoming)
        await ops.write(path, c.req.raw.body ?? new Blob([]).stream(), c.req.raw.signal)
        return c.body(null, 201)
      case 'DELETE':
        await ops.delete(path)
        return c.body(null, 204)
      case 'MKCOL':
        // rclone makes the parent folder before every upload. One that exists answers from the
        // volume's cached listing, without waiting for the account's changes or calling the source.
        if (path && (await ops.stat(path).catch(() => null))?.kind === 'directory') throw new WorkspaceFileError('already-exists')
        await ops.mkdir(path)
        return c.body(null, 201)
      case 'MOVE': {
        const destination = destinationOf(c.req.header('destination'), base)
        await ops.move(path, destination)
        return c.body(null, 201)
      }
      default:
        return c.body(null, 405)
    }
  } catch (error) {
    if (error instanceof DropboxUnavailableError) {
      return c.body(null, error.status, error.retryAfter === undefined ? undefined : { 'Retry-After': String(error.retryAfter) })
    }
    if (error instanceof WorkspaceFileError) return c.body(null, statusOf(c.req.method, path, error))
    throw error
  }
}

volumes.all('/:volumeId', (c) => serve(c, c.req.param('volumeId')))
volumes.all('/:volumeId/*', (c) => serve(c, c.req.param('volumeId')))

export default volumes
