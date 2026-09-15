import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config/settings', () => ({ getSettings: () => ({ apiKeys: { openaiApiKey: 'test-secret-key' } }) }))
vi.mock('../llm-provider/helpers', () => ({ getConfiguredLlmClient: vi.fn(), createSummarizerText: vi.fn() }))
vi.mock('../llm-provider', () => ({ resolveActiveProviderModel: vi.fn() }))
import { OpenaiVoiceProvider } from './openai-provider'
const provider = new OpenaiVoiceProvider()
afterEach(() => vi.unstubAllGlobals())

describe('OpenAI speech synthesis', () => {
  it('streams PCM using the host key, requested voice and speed, and no summarizer', async () => {
    const response = new Response(new Uint8Array([1, 0, 2, 0]))
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const abort = new AbortController()
    const body = await provider.synthesizeSpeech({ text: 'Hello', voice: 'cedar', speed: 1.2 }, abort.signal)
    expect(body).toBe(response.body)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
    expect(options.headers.Authorization).toBe('Bearer test-secret-key')
    expect(JSON.parse(options.body)).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hello', voice: 'cedar', speed: 1.2, response_format: 'pcm' })
    abort.abort()
    expect(options.signal.aborted).toBe(true)
  })
  it('keeps upstream errors out of user-facing messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive upstream details', { status: 403 })))
    await expect(provider.synthesizeSpeech({ text: 'Hello', voice: 'marin', speed: 1 })).rejects.toThrow('OpenAI speech synthesis failed (403).')
  })
})
