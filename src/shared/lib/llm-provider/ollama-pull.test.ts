import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { taskManager } from '../background-work'
import { cancelOllamaPull, listOllamaPulls, ollamaPullTask, startOllamaPull } from './ollama-pull'

const sync = vi.hoisted(() => ({ syncCatalogsForServer: vi.fn(async () => {}) }))
vi.mock('./ollama-catalog-sync', () => sync)

const BASE = 'http://localhost:11434'
const encoder = new TextEncoder()
const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)

/** A pull response the test feeds by hand, split wherever it likes. */
function pullStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  return { response: new Response(body), send: (chunk: Uint8Array) => controller.enqueue(chunk), end: () => controller.close(), fail: (error: Error) => controller.error(error) }
}

const until = (check: () => Promise<boolean>) => vi.waitFor(async () => { if (!await check()) throw new Error('not yet') }, { timeout: 2000, interval: 5 })
const pullsOf = async (state?: string) => (await listOllamaPulls(BASE)).filter(pull => !state || pull.state === state)

let stream: ReturnType<typeof pullStream>
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  sync.syncCatalogsForServer.mockClear()
  sync.syncCatalogsForServer.mockResolvedValue(undefined)
  stream = pullStream()
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    // Stops the stream the way a real fetch does when its signal aborts.
    init.signal?.addEventListener('abort', () => stream.fail(new DOMException('Aborted', 'AbortError')))
    return stream.response
  })
  vi.stubGlobal('fetch', fetchMock)
  taskManager().register(ollamaPullTask)
})
afterEach(() => vi.unstubAllGlobals())

describe('Ollama pulls', () => {
  it('sums layer progress, then syncs the catalog and leaves the list', async () => {
    await startOllamaPull(BASE, 'm:latest')
    expect(await pullsOf()).toMatchObject([{ model: 'm:latest', state: 'running', phase: 'starting' }])
    await until(async () => fetchMock.mock.calls.length === 1)
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ model: 'm:latest', stream: true })

    stream.send(line({ status: 'pulling abc123def456789', digest: 'sha256:a', total: 1000, completed: 250 }))
    await until(async () => (await pullsOf())[0]?.totalBytes === 1000)
    expect((await pullsOf())[0]).toMatchObject({ phase: 'pulling', completedBytes: 250 })

    stream.send(line({ status: 'success' }))
    stream.end()
    await until(async () => (await pullsOf()).length === 0)
    expect(sync.syncCatalogsForServer).toHaveBeenCalledWith(BASE)
  })

  it('copes with a line split across chunks', async () => {
    await startOllamaPull(BASE, 'm:latest')
    await until(async () => fetchMock.mock.calls.length === 1)
    const whole = line({ error: 'pull model manifest: file does not exist' })
    stream.send(whole.slice(0, 5))
    stream.send(whole.slice(5))
    stream.end()
    await until(async () => (await pullsOf('failed')).length === 1)
  })

  it('reports Ollama\'s reason, sent as a line under a 200, and offers no catalog sync', async () => {
    await startOllamaPull(BASE, 'nope:zzz')
    await until(async () => fetchMock.mock.calls.length === 1)
    stream.send(line({ status: 'pulling manifest' }))
    stream.send(line({ error: 'pull model manifest: file does not exist' }))
    stream.end()
    await until(async () => (await pullsOf('failed')).length === 1)
    expect((await pullsOf())[0].error).toBe('pull model manifest: file does not exist')
    expect(sync.syncCatalogsForServer).not.toHaveBeenCalled()
  })

  it('does not start a second pull of the same model', async () => {
    await startOllamaPull(BASE, 'm:latest')
    await until(async () => fetchMock.mock.calls.length === 1)
    await startOllamaPull(BASE, 'm:latest')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tracks models independently', async () => {
    await startOllamaPull(BASE, 'a:latest')
    await startOllamaPull(BASE, 'b:latest')
    expect((await pullsOf()).map(pull => pull.model).sort()).toEqual(['a:latest', 'b:latest'])
    await cancelOllamaPull(BASE, 'a:latest')
    expect((await pullsOf()).map(pull => pull.model)).toEqual(['b:latest'])
    await cancelOllamaPull(BASE, 'b:latest')
  })

  it('cancelling stops the request and leaves no trace, not even a failure', async () => {
    await startOllamaPull(BASE, 'm:latest')
    await until(async () => fetchMock.mock.calls.length === 1)
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!
    await cancelOllamaPull(BASE, 'm:latest')
    expect(signal.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await pullsOf()).toEqual([])
    expect(sync.syncCatalogsForServer).not.toHaveBeenCalled()
  })

  it('can retry after a failure, and a failure can be dismissed', async () => {
    await startOllamaPull(BASE, 'm:latest')
    await until(async () => fetchMock.mock.calls.length === 1)
    stream.send(line({ error: 'no space left on device' }))
    stream.end()
    await until(async () => (await pullsOf('failed')).length === 1)
    await cancelOllamaPull(BASE, 'm:latest')
    expect(await pullsOf()).toEqual([])

    stream = pullStream()
    await startOllamaPull(BASE, 'm:latest')
    expect(await pullsOf('running')).toHaveLength(1)
    await until(async () => fetchMock.mock.calls.length === 2)
    await cancelOllamaPull(BASE, 'm:latest')
  })

  it('leaves no record behind when the pull could not be scheduled', async () => {
    const at = vi.spyOn(taskManager(), 'at').mockRejectedValueOnce(new Error('stopped'))
    await expect(startOllamaPull(BASE, 'm:latest')).rejects.toThrow('stopped')
    expect(await pullsOf()).toEqual([])
    at.mockRestore()
  })

  it('a failed catalog sync does not turn a finished download into a failure', async () => {
    sync.syncCatalogsForServer.mockRejectedValue(new Error('server went away'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startOllamaPull(BASE, 'm:latest')
    await until(async () => fetchMock.mock.calls.length === 1)
    stream.send(line({ status: 'success' }))
    stream.end()
    await until(async () => (await pullsOf()).length === 0)
    warn.mockRestore()
  })
})
