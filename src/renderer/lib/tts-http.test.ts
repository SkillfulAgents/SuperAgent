import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HttpTtsAdapter } from './tts-http'
import type { TtsEvent } from './tts'
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ apiFetch: fetchMock }))
beforeEach(() => fetchMock.mockReset())

function setup() {
  const adapter = new HttpTtsAdapter('openai')
  const output: Array<number[] | TtsEvent> = []
  adapter.onAudio(chunk => output.push([...new Uint8Array(chunk)]))
  adapter.onEvent(event => output.push(event))
  return { adapter, output }
}
function audioStream() {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller }, cancel }))
  return { response, stream, cancel }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('server-streamed TTS adapter', () => {
  it('buffers before initialization and preserves audio/flush order across batches', async () => {
    const first = audioStream(), second = audioStream()
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response)
    const { adapter, output } = setup()
    adapter.speak('Hello '); adapter.speak('world.'); adapter.flush()
    adapter.speak('Next.'); adapter.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    await adapter.connect({ transport: 'http' }, { voice: 'marin', speed: 1.2 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ provider: 'openai', text: 'Hello world.', voice: 'marin', speed: 1.2 })
    first.stream.enqueue(new Uint8Array([1, 2, 3]))
    await settle()
    expect(output).toEqual([[1, 2, 3]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    first.stream.close()
    await settle()
    expect(output[1]).toEqual({ type: 'flushed', sequenceId: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    second.stream.enqueue(new Uint8Array([4, 5])); second.stream.close()
    await settle()
    expect(output.slice(2)).toEqual([[4, 5], { type: 'flushed', sequenceId: 1 }])
    adapter.close()
  })

  it('aborts an active stream and drops all queued work on close', async () => {
    const source = audioStream()
    fetchMock.mockResolvedValue(source.response)
    const { adapter, output } = setup()
    await adapter.connect({ transport: 'http' }, { voice: 'marin' })
    adapter.speak('First.'); adapter.flush(); adapter.speak('Never sent.'); adapter.flush()
    await settle()
    adapter.close()
    await settle()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(output).toEqual([])
  })

  it('clears an in-flight response and allows new speech without leaking old audio', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>(r => { resolve = r }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 0])))
    const { adapter, output } = setup()
    await adapter.connect({ transport: 'http' }, { voice: 'cedar' })
    adapter.speak('Old'); adapter.flush(); adapter.clear()
    adapter.speak('New'); adapter.flush()
    await settle()
    const stale = audioStream()
    resolve(stale.response)
    await settle()
    expect(stale.cancel).toHaveBeenCalledOnce()
    expect(output).toEqual([{ type: 'cleared', sequenceId: 1 }, [9, 0], { type: 'flushed', sequenceId: 2 }])
    adapter.close()
  })

  it('splits oversized batches within the API limit without splitting a surrogate pair', async () => {
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 0])))
    const { adapter, output } = setup()
    await adapter.connect({ transport: 'http' }, { voice: 'marin' })
    const text = 'x'.repeat(4095) + '🌍' + 'y'.repeat(4100)
    adapter.speak(text); adapter.flush()
    await settle()
    const inputs = fetchMock.mock.calls.map(call => JSON.parse(call[1].body).text as string)
    expect(inputs.join('')).toBe(text)
    expect(inputs.every(input => input.length <= 4096 && !/[\uD800-\uDBFF]$/.test(input))).toBe(true)
    expect(output.filter(item => !Array.isArray(item))).toEqual([{ type: 'flushed', sequenceId: 0 }])
    adapter.close()
  })

  it.each([new Response('proxy error', { status: 502 }), Response.json({ error: 'Voice provider changed. Restart read-aloud.' }, { status: 409 })])('surfaces HTTP failures once and does not synthesize queued text', async response => {
    fetchMock.mockResolvedValue(response)
    const { adapter, output } = setup()
    await adapter.connect({ transport: 'http' }, { voice: 'marin' })
    adapter.speak('First'); adapter.flush(); adapter.speak('Second'); adapter.flush()
    await settle()
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ type: 'error', error: expect.any(Error) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a truncated stream as an error without marking the batch flushed', async () => {
    const source = audioStream()
    fetchMock.mockResolvedValue(source.response)
    const { adapter, output } = setup()
    await adapter.connect({ transport: 'http' }, { voice: 'marin' })
    adapter.speak('Hello'); adapter.flush()
    source.stream.enqueue(new Uint8Array([1, 0]))
    await settle()
    source.stream.error(new Error('Connection lost'))
    await settle()
    expect(output).toEqual([[1, 0], { type: 'error', error: expect.any(Error) }])
  })
})
