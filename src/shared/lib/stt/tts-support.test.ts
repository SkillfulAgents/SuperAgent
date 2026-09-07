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
import { DEEPGRAM_TTS_VOICES } from './deepgram-voices'
import { resolveTtsSpeed } from './tts-preferences'

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

describe('provider voice catalogue', () => {
  it('Deepgram and platform offer the same Aura voices; OpenAI offers none', () => {
    expect(getSttProvider('deepgram').getTtsVoices()).toBe(DEEPGRAM_TTS_VOICES)
    expect(getSttProvider('platform').getTtsVoices()).toBe(DEEPGRAM_TTS_VOICES)
    expect(getSttProvider('openai').getTtsVoices()).toEqual([])
    expect(getSttProvider('openai').getDefaultTtsVoice()).toBeUndefined()
  })

  it('the default is the first voice and every id in the catalogue is recognised', () => {
    const deepgram = getSttProvider('deepgram')
    expect(deepgram.getDefaultTtsVoice()).toBe(DEEPGRAM_TTS_VOICES[0].id)
    for (const v of DEEPGRAM_TTS_VOICES) expect(deepgram.hasTtsVoice(v.id)).toBe(true)
    expect(deepgram.hasTtsVoice('aura-asteria-en')).toBe(false)
    expect(deepgram.hasTtsVoice(undefined)).toBe(false)
  })

  it('resolves the first pick the provider offers, then the default', () => {
    const deepgram = getSttProvider('deepgram')
    expect(deepgram.resolveTtsVoice('aura-2-luna-en', 'aura-2-zeus-en')).toBe('aura-2-luna-en')
    expect(deepgram.resolveTtsVoice(undefined, 'aura-2-zeus-en')).toBe('aura-2-zeus-en')
    expect(deepgram.resolveTtsVoice('aura-asteria-en', 'nope')).toBe(DEEPGRAM_TTS_VOICES[0].id)
    expect(deepgram.resolveTtsVoice()).toBe(DEEPGRAM_TTS_VOICES[0].id)
  })
})

describe('resolveTtsSpeed', () => {
  it('keeps a speed in range and falls back to normal otherwise', () => {
    expect(resolveTtsSpeed(1.2)).toBe(1.2)
    expect(resolveTtsSpeed(3)).toBe(1)
    expect(resolveTtsSpeed(undefined)).toBe(1)
  })
})
