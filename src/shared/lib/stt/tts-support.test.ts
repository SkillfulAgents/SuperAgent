import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/settings', () => ({
  getSettings: () => ({ apiKeys: { deepgramApiKey: 'dg-key', openaiApiKey: 'oa-key' } }),
  getVoiceSettings: () => ({}),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => 'platform-token',
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))

import { getSttProvider } from './index'
import { DEFAULT_TTS_VOICE, TTS_VOICES, isTtsVoice, ttsVoiceSchema } from './tts-voices'

describe('text-to-speech provider support', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('Deepgram and platform can speak; OpenAI cannot (yet)', () => {
    expect(getSttProvider('deepgram').supportsTts()).toBe(true)
    expect(getSttProvider('platform').supportsTts()).toBe(true)
    expect(getSttProvider('openai').supportsTts()).toBe(false)
  })

  it('mints the same grant token for speech as for transcription', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: 'jwt' }), { status: 200 }),
    )
    await expect(getSttProvider('deepgram').getTtsToken()).resolves.toEqual({ provider: 'deepgram', token: 'jwt' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepgram.com/v1/auth/grant')

    await expect(getSttProvider('platform').getTtsToken()).resolves.toEqual({ provider: 'platform', token: 'jwt' })
    expect(fetchMock.mock.calls[1][0]).toBe('https://proxy.test/v1/deepgram/auth/grant')
  })

  it('refuses to mint for a provider without speech', async () => {
    await expect(getSttProvider('openai').getTtsToken()).rejects.toThrow('Text-to-speech not supported by OpenAI')
  })
})

describe('tts voices', () => {
  it('the default is in the catalogue and the schema accepts exactly the catalogue', () => {
    expect(TTS_VOICES.some((v) => v.id === DEFAULT_TTS_VOICE)).toBe(true)
    for (const v of TTS_VOICES) expect(ttsVoiceSchema.safeParse(v.id).success).toBe(true)
    expect(isTtsVoice('aura-2-thalia-en')).toBe(true)
    expect(isTtsVoice('aura-asteria-en')).toBe(false)
    expect(isTtsVoice(undefined)).toBe(false)
  })
})
