import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ token: 'platform-token' as string | null, summarize: vi.fn() }))
vi.mock('../config/settings', () => ({
  getSettings: () => ({ apiKeys: { openaiApiKey: 'byok-key-must-not-be-used' } }),
  getEffectiveModels: () => ({ summarizerModel: 'summary-model' }),
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: () => mocks.token }))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.test' }))
vi.mock('../llm-provider/helpers', () => ({ getConfiguredLlmClient: () => ({}), createSummarizerText: mocks.summarize }))
vi.mock('../llm-provider', () => ({ resolveActiveProviderModel: () => 'summary-model' }))
import { PlatformVoiceProvider } from './platform-provider'

const provider = new PlatformVoiceProvider()
const fetchMock = vi.fn()
beforeEach(() => { mocks.token = 'platform-token'; vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return { url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined }
}

describe('PlatformVoiceProvider', () => {
  it('is configured only by the platform token, never by a stored OpenAI key', () => {
    expect(provider.getApiKeyStatus()).toEqual({ isConfigured: true, source: 'settings' })
    expect(provider.getEffectiveApiKey()).toBe('platform-token')
    mocks.token = null
    expect(provider.getApiKeyStatus()).toEqual({ isConfigured: false, source: 'none' })
    expect(provider.getEffectiveApiKey()).toBeUndefined()
  })

  it('routes speech synthesis through the proxy OpenAI lane with the platform bearer', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 0])))
    await provider.synthesizeSpeech({ text: 'Hi', voice: 'marin', speed: 1 })
    const { url, headers, body } = lastCall()
    expect(url).toBe('https://proxy.test/v1/openai/audio/speech')
    expect(headers.Authorization).toBe('Bearer platform-token')
    expect(body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Hi', response_format: 'pcm' })
  })

  it('mints dictation and voice-agent client secrets through the proxy', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ value: 'ek_1' })))
    await expect(provider.getEphemeralToken()).resolves.toEqual({ provider: 'platform', token: 'ek_1' })
    expect(lastCall()).toMatchObject({ url: 'https://proxy.test/v1/openai/realtime/client_secrets', body: { session: { type: 'transcription' } } })
    await expect(provider.getVoiceAgentToken()).resolves.toEqual({ provider: 'platform', token: 'ek_1' })
    expect(lastCall().body).toEqual({ session: { type: 'realtime' } })
  })

  it('creates and closes Live sessions through the proxy', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'live_1' }, transport: { sdp: 'answer' } })))
    await expect(provider.createLiveSession('offer', [])).resolves.toEqual({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'answer' } })
    expect(lastCall().url).toBe('https://proxy.test/v1/openai/live/sessions')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await provider.closeLiveSession('live_1')
    expect(lastCall().url).toBe('https://proxy.test/v1/openai/live/sessions/live_1/hangup')
    expect(provider.getConversationEngine()).toBe('openai-live')
  })

  it('transcribes through the proxy', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'hello' })))
    await expect(provider.transcribe(Buffer.from([1, 2]), 'audio/ogg')).resolves.toBe('hello')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://proxy.test/v1/openai/audio/transcriptions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer platform-token')
  })

  it('uses platform wording for missing connection, auth, and balance failures', async () => {
    mocks.token = null
    await expect(provider.synthesizeSpeech({ text: 'Hi', voice: 'marin', speed: 1 })).rejects.toThrow('Connect your platform account')
    mocks.token = 'platform-token'
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 403 }))
    await expect(provider.getEphemeralToken()).rejects.toThrow('Platform voice authentication failed')
    fetchMock.mockResolvedValueOnce(new Response('blocked', { status: 402 }))
    await expect(provider.synthesizeSpeech({ text: 'Hi', voice: 'marin', speed: 1 })).rejects.toThrow('workspace balance')
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(provider.createLiveSession('offer', [])).rejects.toThrow('Check your platform voice access')
  })

  it('validates the platform token by minting a short-lived client secret', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ value: 'ek_probe' })))
    await expect(provider.validateKey('platform-token')).resolves.toEqual({ valid: true })
    expect(lastCall().body).toEqual({ expires_after: { anchor: 'created_at', seconds: 60 }, session: { type: 'transcription' } })
    fetchMock.mockResolvedValueOnce(new Response('denied', { status: 401 }))
    await expect(provider.validateKey('bad')).resolves.toMatchObject({ valid: false, error: expect.stringContaining('authentication failed') })
  })
})
