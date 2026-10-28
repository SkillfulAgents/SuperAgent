import type { Context } from 'hono'
import { Readable, pipeline } from 'stream'
import { createJsonArrayStringifyTransform } from '@shared/lib/utils/file-storage'
import { captureException } from '@shared/lib/error-reporting'

/**
 * Respond with `items` serialized as a JSON array, streamed element by element
 * instead of materialized as one `JSON.stringify` string (the transform matches
 * `c.json` semantics exactly, including `undefined` elements becoming `null`).
 *
 * A client that disconnects mid-body cancels the returned web stream, which
 * surfaces Node-side as ABORT_ERR / ERR_STREAM_PREMATURE_CLOSE — routine
 * connection churn, filtered out before reporting.
 */
export function streamJsonArrayResponse(
  c: Context,
  items: unknown[],
  options: { logLabel: string; tags: { component: string; operation: string } }
): Response {
  const stringify = createJsonArrayStringifyTransform()
  pipeline(Readable.from(items), stringify, (err) => {
    if (!err) return
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE') return
    console.error(`Failed to stream ${options.logLabel}:`, err)
    captureException(err, { tags: options.tags })
  })
  return c.body(Readable.toWeb(stringify) as ReadableStream, 200, {
    'Content-Type': 'application/json',
  })
}
