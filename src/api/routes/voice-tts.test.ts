import { VoiceProviderError } from '@shared/lib/voice/provider-error'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  selected: 'openai' as string | undefined, authenticated: true,
  synthesize: vi.fn(), connection: vi.fn(),
  preferences: { ttsVoice: 'cedar', ttsSpeed: 1.2 },
}))
vi.mock('../middleware/auth', () => ({ ResolveAgent: () => async (_c: unknown, next: () => Promise<void>) => next(), AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(), Authenticated: () => async (_c: unknown, next: () => Promise<void>) => mocks.authenticated ? next() : new Response('Unauthorized', { status: 401 }) }))
vi.mock('@shared/lib/config/settings', () => ({ getVoiceSettings: () => ({ sttProvider: mocks.selected, ttsVoice: 'marin' }) }))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => 'member' }))
vi.mock('@shared/lib/services/user-settings-service', () => ({ getUserSettings: () => ({ voice: mocks.preferences }) }))
vi.mock('@shared/lib/voice', () => ({ getVoiceProvider: (id: string) => ({
  id, name: id === 'openai' ? 'OpenAI' : 'Deepgram', supportsTts: () => true,
  getTtsConnection: mocks.connection,
  getTtsSynthesis: () => id === 'openai' ? { synthesizeSpeech: mocks.synthesize } : null,
  hasTtsVoice: (voice: string) => ['marin', 'cedar'].includes(voice),
  resolveTtsVoice: (personal?: string, fallback?: string) => [personal, fallback, 'marin'].find(voice => voice && ['marin', 'cedar'].includes(voice)),
}) }))
import voice from './voice'
const input = { provider: 'openai', text: 'Hello', voice: 'cedar', speed: 1.2 }
function synthesize(body: unknown = input, signal?: AbortSignal) {
  return voice.request('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.selected = 'openai'; mocks.authenticated = true
  mocks.preferences = { ttsVoice: 'cedar', ttsSpeed: 1.2 }
  mocks.connection.mockResolvedValue({ transport: 'http' })
  mocks.synthesize.mockImplementation(async () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 0, 2, 0])); controller.close() } }))
})

describe('provider-neutral TTS routes', () => {
  it('initializes member voice and speed without exposing an API key', async () => {
    const response = await voice.request('/tts-session')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ provider: 'openai', connection: { transport: 'http' }, voice: 'cedar', speed: 1.2 })
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })
  it('preserves token-based initialization for Deepgram', async () => {
    mocks.selected = 'deepgram'
    mocks.connection.mockResolvedValue({ transport: 'websocket', token: 'ephemeral' })
    expect(await (await voice.request('/tts-session')).json()).toMatchObject({ provider: 'deepgram', connection: { transport: 'websocket', token: 'ephemeral' } })
  })
  it('keeps the legacy token response as a compatibility wrapper', async () => {
    mocks.selected = 'deepgram'
    mocks.connection.mockResolvedValue({ transport: 'websocket', token: 'ephemeral' })
    expect(await (await voice.request('/tts-token')).json()).toEqual({ provider: 'deepgram', token: 'ephemeral', voice: 'cedar', speed: 1.2 })
  })
  it.each([
    [400, 'No API key configured for Deepgram. Add one in Settings > Voice.'],
    [400, 'Text-to-speech not supported by Deepgram'],
    [502, 'Deepgram rejected the API key. Update it in Settings > Voice.'],
  ] as const)('preserves safe provider errors (%s)', async (status, message) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mocks.connection.mockRejectedValue(new VoiceProviderError(message, status))
      const response = await voice.request('/tts-session')
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: message })
      expect(log).toHaveBeenCalledTimes(status === 502 ? 1 : 0)
    } finally { log.mockRestore() }
  })
  it('logs unexpected setup failures without exposing upstream details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mocks.connection.mockRejectedValue(new Error('private upstream detail'))
      const response = await voice.request('/tts-session')
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('private upstream detail')
      expect(log).toHaveBeenCalledOnce()
    } finally { log.mockRestore() }
  })
  it('falls back from a voice saved for another provider', async () => {
    mocks.preferences.ttsVoice = 'aura-2-thalia-en'
    expect(await (await voice.request('/tts-session')).json()).toMatchObject({ voice: 'marin' })
  })
  it('requires authentication for setup and synthesis', async () => {
    mocks.authenticated = false
    expect((await voice.request('/tts-session')).status).toBe(401)
    expect((await synthesize()).status).toBe(401)
    expect(mocks.connection).not.toHaveBeenCalled()
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })
  it('streams provider PCM and passes through cancellation', async () => {
    const abort = new AbortController()
    const response = await synthesize(input, abort.signal)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('audio/pcm')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 0, 2, 0])
    expect(mocks.synthesize).toHaveBeenCalledWith({ text: 'Hello', voice: 'cedar', speed: 1.2 }, expect.any(AbortSignal))
    abort.abort()
    expect(mocks.synthesize.mock.calls[0][1].aborted).toBe(true)
  })
  it('does not buffer the audio and cancels the underlying stream when the reader stops', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const cancelled = vi.fn()
    mocks.synthesize.mockResolvedValue(new ReadableStream({ start(value) { controller = value }, cancel: cancelled }))
    const response = await synthesize()
    const reader = response.body!.getReader()
    controller.enqueue(new Uint8Array([1, 0]))
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 0]))
    await reader.cancel()
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it.each([{ text: '' }, { text: 'x'.repeat(4097) }, { speed: 5 }, { voice: 'unknown' }])('validates synthesis input: %j', async override => {
    expect((await synthesize({ ...input, ...override })).status).toBe(400)
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })
  it('bounds request bodies before synthesis', async () => {
    expect((await synthesize({ ...input, text: 'x'.repeat(33000) })).status).toBe(413)
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })
  it('refuses a stale reader after the selected provider changes', async () => {
    mocks.selected = 'deepgram'
    const response = await synthesize()
    expect(response.status).toBe(409)
    expect(mocks.synthesize).not.toHaveBeenCalled()
  })
  it('names a provider without server-side synthesis', async () => {
    mocks.selected = 'deepgram'
    const response = await synthesize({ ...input, provider: 'deepgram' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Server-side speech synthesis not supported with current configured voice provider: Deepgram' })
  })
  it('reports missing configuration and hides upstream errors', async () => {
    mocks.selected = undefined
    expect((await voice.request('/tts-session')).status).toBe(400)
    expect((await synthesize()).status).toBe(400)
    mocks.selected = 'openai'
    mocks.synthesize.mockRejectedValue(new Error('secret error'))
    const response = await synthesize()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret')
  })
})
