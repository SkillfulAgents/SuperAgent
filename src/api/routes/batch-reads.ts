import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { isBatchableRead, MAX_BATCHED_READS, type BatchedReadAnswer } from '@shared/lib/batched-reads'

const bodySchema = z.object({ paths: z.array(z.string()).min(1).max(MAX_BATCHED_READS) })

/**
 * Answers several reads in one request, so a page that needs many small reads
 * at once does not send each by itself. `dispatch` hands every read to the app
 * as its own GET with the caller's headers: each route keeps its own access
 * checks, and its status and body come back unchanged.
 *
 * The response is one JSON line per read (`BatchedReadAnswer`), written when
 * that read finishes: a fast read does not wait for a slow one in its batch.
 */
export function batchReads(dispatch: (request: Request, c: Context) => Response | Promise<Response>) {
  const routes = new Hono()

  routes.post('/', async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: `paths must hold 1 to ${MAX_BATCHED_READS} paths` }, 400)
    const { paths } = parsed.data
    const refused = paths.find((path) => !isBatchableRead(path))
    if (refused !== undefined) return c.json({ error: `Not a batchable read: ${refused}` }, 400)

    const origin = new URL(c.req.url).origin
    // The caller's identity goes with each read; the batch's own body headers do not.
    const headers = new Headers(c.req.raw.headers)
    headers.delete('content-length')
    headers.delete('content-type')
    const signal = c.req.raw.signal

    c.header('Content-Type', 'application/x-ndjson')
    return stream(c, async (lines) => {
      await Promise.all(paths.map(async (path, index) => {
        const response = await dispatch(new Request(origin + path, { headers, signal }), c)
        const answer: BatchedReadAnswer = { index, status: response.status, contentType: response.headers.get('content-type'), body: await response.text() }
        await lines.write(`${JSON.stringify(answer)}\n`)
      }))
    })
  })

  return routes
}
