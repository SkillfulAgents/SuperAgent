import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BatchedReadAnswer } from '@shared/lib/batched-reads'
import { createReadBatcher } from './read-batcher'

const alone = vi.fn<(path: string) => Promise<Response>>()
const batch = vi.fn<(paths: string[]) => Promise<Response>>()
const answered = vi.fn(async (_status: number, _path: string) => {})

const line = (index: number, status: number, body: unknown) =>
  `${JSON.stringify({ index, status, contentType: 'application/json', body: JSON.stringify(body) } satisfies BatchedReadAnswer)}\n`

/** A batch response whose lines the test sends one by one. */
function openBatchAnswer() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c } })
  return {
    response: new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    send: (data: string | Uint8Array) => controller.enqueue(typeof data === 'string' ? new TextEncoder().encode(data) : data),
    end: () => controller.close(),
  }
}

const batchAnswer = (...lines: string[]) => new Response(lines.join(''), { headers: { 'Content-Type': 'application/x-ndjson' } })

let read: (path: string) => Promise<Response>

beforeEach(() => {
  alone.mockReset()
  batch.mockReset()
  answered.mockClear()
  read = createReadBatcher({ alone, batch, answered })
})

describe('createReadBatcher', () => {
  it('sends reads asked for together as one request, and gives each caller its own answer', async () => {
    batch.mockResolvedValueOnce(batchAnswer(line(1, 403, { error: 'Forbidden' }), line(0, 200, { hooks: [] })))

    const [hooks, mounts] = await Promise.all([read('/api/agents/sales/hooks'), read('/api/agents/sales/mounts')])

    expect(batch.mock.calls).toEqual([[['/api/agents/sales/hooks', '/api/agents/sales/mounts']]])
    expect(alone).not.toHaveBeenCalled()
    expect([hooks.status, await hooks.json()]).toEqual([200, { hooks: [] }])
    expect([mounts.ok, mounts.status, await mounts.json()]).toEqual([false, 403, { error: 'Forbidden' }])
  })

  it('gives a caller its answer when the server sends it, while a slower read of the batch is still open', async () => {
    const answer = openBatchAnswer()
    batch.mockResolvedValueOnce(answer.response)
    const slow = read('/api/skillsets')
    const fast = read('/api/agents/sales/hooks')
    let slowAnswered = false
    void slow.then(() => { slowAnswered = true })

    answer.send(line(1, 200, { hooks: [] }))

    expect(await (await fast).json()).toEqual({ hooks: [] })
    expect(slowAnswered).toBe(false)
    answer.send(line(0, 200, { skillsets: [] }))
    answer.end()
    expect(await (await slow).json()).toEqual({ skillsets: [] })
  })

  it('reads an answer that arrives split across chunks, even inside a character', async () => {
    const answer = openBatchAnswer()
    batch.mockResolvedValueOnce(answer.response)
    const reads = Promise.all([read('/api/agents/sales/hooks'), read('/api/agents/sales/mounts')])
    const bytes = new TextEncoder().encode(line(0, 200, { name: 'Zoë' }) + line(1, 200, { mounts: [] }))
    // Inside the two bytes of "ë", and so inside the first line.
    const cut = bytes.indexOf(0xc3) + 1

    answer.send(bytes.slice(0, cut))
    answer.send(bytes.slice(cut))
    answer.end()

    expect(await Promise.all((await reads).map((response) => response.json()))).toEqual([{ name: 'Zoë' }, { mounts: [] }])
  })

  it('sends a read asked for alone as a plain request', async () => {
    alone.mockResolvedValueOnce(Response.json({ hooks: [] }))

    const response = await read('/api/agents/sales/hooks')

    expect(alone.mock.calls).toEqual([['/api/agents/sales/hooks']])
    expect(batch).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ hooks: [] })
  })

  it('sends each read by itself when the server has no batch route', async () => {
    batch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    alone.mockImplementation(async (path) => Response.json({ from: path }))

    const answers = await Promise.all([read('/api/agents/sales/hooks'), read('/api/agents/sales/mounts')])

    expect(await Promise.all(answers.map((answer) => answer.json()))).toEqual([{ from: '/api/agents/sales/hooks' }, { from: '/api/agents/sales/mounts' }])
  })

  it('sends by itself a read the batch response ended without answering', async () => {
    batch.mockResolvedValueOnce(batchAnswer(line(0, 200, { hooks: [] })))
    alone.mockImplementation(async (path) => Response.json({ from: path }))

    const [hooks, mounts] = await Promise.all([read('/api/agents/sales/hooks'), read('/api/agents/sales/mounts')])

    expect(await hooks.json()).toEqual({ hooks: [] })
    expect(alone.mock.calls).toEqual([['/api/agents/sales/mounts']])
    expect(await mounts.json()).toEqual({ from: '/api/agents/sales/mounts' })
  })

  it('tells of each status before its caller gets the answer, as a lone read is handled', async () => {
    batch.mockResolvedValueOnce(batchAnswer(line(0, 401, {}), line(1, 200, {})))

    await Promise.all([read('/api/agents/sales/hooks'), read('/api/agents/sales/mounts')])

    expect(answered.mock.calls).toEqual([[401, '/api/agents/sales/hooks'], [200, '/api/agents/sales/mounts']])
  })

  it('rejects every read of a batch that could not be sent', async () => {
    batch.mockRejectedValueOnce(new Error('offline'))

    const outcomes = await Promise.allSettled([read('/api/agents/sales/hooks'), read('/api/agents/sales/mounts')])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(alone).not.toHaveBeenCalled()
  })
})
