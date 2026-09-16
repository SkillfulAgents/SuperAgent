import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config/settings', () => ({ getSettings: () => ({ apiKeys: { openaiApiKey: 'test-secret-key' } }) }))
vi.mock('../llm-provider/helpers', () => ({ getConfiguredLlmClient: vi.fn(), createSummarizerText: vi.fn() }))
vi.mock('../llm-provider', () => ({ resolveActiveProviderModel: vi.fn() }))
import { OpenaiVoiceProvider } from './openai-provider'
const provider = new OpenaiVoiceProvider()
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('OpenAI speech synthesis', () => {
  it('streams PCM using the host key, requested voice and speed, and no summarizer', async () => {
    const response = new Response(new Uint8Array([1, 0, 2, 0]))
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const abort = new AbortController()
    const body = await provider.synthesizeSpeech({ text: 'Hello', voice: 'cedar', speed: 1.2 }, abort.signal)
    expect(body).toBeInstanceOf(ReadableStream)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
    expect(options.headers.Authorization).toBe('Bearer test-secret-key')
    expect(JSON.parse(options.body)).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hello', voice: 'cedar', speed: 1.2, response_format: 'pcm' })
    abort.abort()
    expect(options.signal.aborted).toBe(true)
  })
  it('advertises standard TTS and the real default catalogue', async () => {
    expect(provider.supportsTts()).toBe(true)
    expect(provider.getDefaultTtsVoice()).toBe('marin')
    expect(provider.getTtsVoices()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'marin' }), expect.objectContaining({ id: 'cedar' })]))
    expect(await provider.getTtsConnection()).toEqual({ transport: 'http' })
  })
  it('keeps a progressing upstream synthesis alive beyond thirty seconds', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const abort = new AbortController()
      setTimeout(() => abort.abort(new DOMException('Timeout', 'TimeoutError')), ms)
      return abort.signal
    })
    let source!: ReadableStreamDefaultController<Uint8Array>
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
        init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason))
      },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const body = await provider.synthesizeSpeech({ text: 'A long response', voice: 'marin', speed: 0.7 })
    const reader = body.getReader()
    for (let i = 0; i < 8; i++) {
      const read = reader.read()
      await vi.advanceTimersByTimeAsync(5_000)
      source.enqueue(new Uint8Array([1, 0]))
      expect((await read).value).toEqual(new Uint8Array([1, 0]))
    }
    source.close()
    expect((await reader.read()).done).toBe(true)
    expect(fetchMock.mock.calls[0][1].signal!.aborted).toBe(false)
  })
  it('keeps upstream errors out of user-facing messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive upstream details', { status: 403 })))
    await expect(provider.synthesizeSpeech({ text: 'Hello', voice: 'marin', speed: 1 })).rejects.toThrow('OpenAI rejected speech synthesis access.')
  })
})
