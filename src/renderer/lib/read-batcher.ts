import { MAX_BATCHED_READS, type BatchModule, type BatchedReadAnswer } from '@shared/lib/batched-reads'

interface WaitingRead {
  path: string
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

export interface ReadBatcherLinks {
  /** Sends one read by itself. */
  alone: (path: string) => Promise<Response>
  /** Sends `POST /api/batch-reads` with these paths. */
  batch: (paths: string[]) => Promise<Response>
  /** Told each batched read's status before its caller gets the answer, as a lone read's response is handled. */
  answered: (status: number, path: string) => Promise<void>
}

/** Statuses a Response may not carry a body with. */
const BODILESS = new Set([204, 205, 304])

/**
 * Returns a read function for the GETs of a page's modules
 * (`@shared/lib/batched-reads`). The reads of one module asked for in the same
 * turn of the event loop go out as one request, and each caller gets the
 * Response its own route gave, as soon as the server has it. Two modules never
 * share a request, so a slow one holds back only its own part of the screen. A
 * read asked for alone is a plain request.
 */
export function createReadBatcher(links: ReadBatcherLinks): (module: BatchModule, path: string) => Promise<Response> {
  let waiting = new Map<BatchModule, WaitingRead[]>()

  function sendWaiting(): void {
    const modules = waiting
    waiting = new Map()
    for (const reads of modules.values()) {
      for (let start = 0; start < reads.length; start += MAX_BATCHED_READS) {
        void send(reads.slice(start, start + MAX_BATCHED_READS))
      }
    }
  }

  function sendEachAlone(reads: Iterable<WaitingRead>): void {
    for (const read of reads) links.alone(read.path).then(read.resolve, read.reject)
  }

  async function send(reads: WaitingRead[]): Promise<void> {
    if (reads.length === 1) return sendEachAlone(reads)
    const unanswered = new Map(reads.map((read, index) => [index, read]))
    try {
      const response = await links.batch(reads.map((read) => read.path))
      if (response.ok && response.body) {
        await eachLine(response.body, async (line) => {
          const answer = JSON.parse(line) as BatchedReadAnswer
          const read = unanswered.get(answer.index)
          if (!read) return
          unanswered.delete(answer.index)
          await links.answered(answer.status, read.path)
          read.resolve(new Response(BODILESS.has(answer.status) ? null : answer.body, {
            status: answer.status,
            headers: answer.contentType ? { 'Content-Type': answer.contentType } : undefined,
          }))
        })
      }
    } catch (error) {
      // What a lone read would have rejected with: the network failed, or the workspace is not available.
      for (const read of unanswered.values()) read.reject(error)
      return
    }
    // A server without the route, or a response that ended before every answer: those reads go by themselves.
    sendEachAlone(unanswered.values())
  }

  return (module, path) => new Promise((resolve, reject) => {
    if (waiting.size === 0) setTimeout(sendWaiting, 0)
    const reads = waiting.get(module) ?? []
    reads.push({ path, resolve, reject })
    waiting.set(module, reads)
  })
}

/** Calls `onLine` with each line of a text stream as it arrives. */
async function eachLine(body: ReadableStream<Uint8Array>, onLine: (line: string) => Promise<void>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const { done, value } = await reader.read()
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line) await onLine(line)
    if (done) break
  }
  if (pending) await onLine(pending)
}
