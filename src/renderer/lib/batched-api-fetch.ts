import { apiFetch, handleUnauthorizedResponse } from './api'

interface WaitingRead {
  path: string
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

/** As the server's MAX_BATCHED_READS. */
const MAX_READS_PER_REQUEST = 20
/** Statuses a Response may not carry a body with. */
const BODILESS = new Set([204, 205, 304])

let waiting: WaitingRead[] = []

/**
 * `apiFetch` for a GET that other reads start beside, as a page's sections do
 * when they mount together. Reads asked for in the same turn of the event loop
 * go out as one request (`POST /api/batch-reads`) and each caller gets the
 * Response its own route gave. A read asked for alone is a plain `apiFetch`.
 * Only for the paths the server batches (see batch-reads.ts).
 */
export function batchedApiFetch(path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    waiting.push({ path, resolve, reject })
    if (waiting.length === 1) setTimeout(sendWaiting, 0)
  })
}

function sendWaiting(): void {
  const reads = waiting
  waiting = []
  for (let start = 0; start < reads.length; start += MAX_READS_PER_REQUEST) {
    void send(reads.slice(start, start + MAX_READS_PER_REQUEST))
  }
}

function sendEachAlone(reads: WaitingRead[]): void {
  for (const read of reads) apiFetch(read.path).then(read.resolve, read.reject)
}

async function send(reads: WaitingRead[]): Promise<void> {
  if (reads.length === 1) return sendEachAlone(reads)
  try {
    const response = await apiFetch('/api/batch-reads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: reads.map((read) => read.path) }),
    })
    // A server without the route (an older cloud workspace): each read goes by itself, as before.
    if (!response.ok) return sendEachAlone(reads)
    const { results } = (await response.json()) as { results: Array<{ status: number; contentType: string | null; body: string }> }
    await Promise.all(reads.map(async (read, index) => {
      const result = results[index]
      await handleUnauthorizedResponse(result.status, read.path)
      read.resolve(new Response(BODILESS.has(result.status) ? null : result.body, {
        status: result.status,
        headers: result.contentType ? { 'Content-Type': result.contentType } : undefined,
      }))
    }))
  } catch (error) {
    // What a lone apiFetch would have rejected with: the network failed, or the workspace is not available.
    for (const read of reads) read.reject(error)
  }
}
