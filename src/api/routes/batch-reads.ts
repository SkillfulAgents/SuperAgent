import { Hono, type Context } from 'hono'
import { z } from 'zod'

/**
 * The reads a page makes for one agent's sections. Each is a GET the caller
 * could send by itself; nothing here is readable only through a batch.
 */
const BATCHABLE_READS = [
  /^\/api\/agents\/[^/?#]+\/(?:webhook-triggers|scheduled-tasks|scheduled-tasks\/completed-sessions|connected-accounts|remote-mcps|skills|mounts|hooks)(?:\?[^#]*)?$/,
  /^\/api\/activity\/agents\/[^/?#]+(?:\?[^#]*)?$/,
  /^\/api\/agent-integrations\/agents\/[^/?#]+(?:\?[^#]*)?$/,
  /^\/api\/volume-definitions$/,
]

export const MAX_BATCHED_READS = 20

const bodySchema = z.object({ paths: z.array(z.string()).min(1).max(MAX_BATCHED_READS) })

export interface BatchedRead {
  status: number
  contentType: string | null
  body: string
}

/** A path as the app will route it: one that names another route once normalized (`..`) is not the read it claims to be. */
function isBatchableRead(path: string, origin: string): boolean {
  if (!BATCHABLE_READS.some((read) => read.test(path))) return false
  const url = new URL(origin + path)
  return url.pathname + url.search === path
}

/**
 * Answers several reads in one request, so a page that needs many small reads
 * at once does not send each by itself. `dispatch` hands every read to the app
 * as its own GET with the caller's headers: each route keeps its own access
 * checks, and its status and body come back unchanged.
 */
export function batchReads(dispatch: (request: Request, c: Context) => Response | Promise<Response>) {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: `paths must hold 1 to ${MAX_BATCHED_READS} paths` }, 400)
    const { paths } = parsed.data
    const origin = new URL(c.req.url).origin
    const refused = paths.find((path) => !isBatchableRead(path, origin))
    if (refused !== undefined) return c.json({ error: `Not a batchable read: ${refused}` }, 400)

    // The caller's identity goes with each read; the batch's own body headers do not.
    const headers = new Headers(c.req.raw.headers)
    headers.delete('content-length')
    headers.delete('content-type')

    const results = await Promise.all(paths.map(async (path): Promise<BatchedRead> => {
      const response = await dispatch(new Request(origin + path, { headers, signal: c.req.raw.signal }), c)
      return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() }
    }))
    return c.json({ results })
  })

  return routes
}
