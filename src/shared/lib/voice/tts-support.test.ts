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

import { getVoiceProvider } from './index'
import { DEEPGRAM_TTS_VOICES } from './deepgram-voices'
import { resolveTtsSpeed } from './tts-preferences'

describe('text-to-speech provider support', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('all configured voice providers support read-aloud', () => {
    expect(getVoiceProvider('deepgram').supportsTts()).toBe(true)
    expect(getVoiceProvider('platform').supportsTts()).toBe(true)
    expect(getVoiceProvider('openai').supportsTts()).toBe(true)
  })

  it('initializes OpenAI without returning a token or making an upstream request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(getVoiceProvider('openai').getTtsConnection()).resolves.toEqual({ transport: 'http' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mints the same grant token for speech as for transcription', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ access_token: 'jwt' }), { status: 200 }),
    )
    await expect(getVoiceProvider('deepgram').getTtsToken()).resolves.toEqual({ provider: 'deepgram', token: 'jwt' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepgram.com/v1/auth/grant')

    await expect(getVoiceProvider('platform').getTtsToken()).resolves.toEqual({ provider: 'platform', token: 'jwt' })
    expect(fetchMock.mock.calls[1][0]).toBe('https://proxy.test/v1/deepgram/auth/grant')
  })

  it('does not mint a browser token for server-side OpenAI speech', async () => {
    await expect(getVoiceProvider('openai').getTtsToken()).rejects.toThrow('Text-to-speech not supported by OpenAI')
  })
})

describe('provider voice catalogue', () => {
  it('Deepgram and platform offer Aura voices; OpenAI offers its own catalogue', () => {
    expect(getVoiceProvider('deepgram').getTtsVoices()).toBe(DEEPGRAM_TTS_VOICES)
    expect(getVoiceProvider('platform').getTtsVoices()).toBe(DEEPGRAM_TTS_VOICES)
    expect(getVoiceProvider('openai').getTtsVoices()).toContainEqual({ id: 'marin', label: 'Marin', description: 'OpenAI' })
    expect(getVoiceProvider('openai').getDefaultTtsVoice()).toBe('marin')
  })

  it('the default is the first voice and every id in the catalogue is recognised', () => {
    const deepgram = getVoiceProvider('deepgram')
    expect(deepgram.getDefaultTtsVoice()).toBe(DEEPGRAM_TTS_VOICES[0].id)
    for (const v of DEEPGRAM_TTS_VOICES) expect(deepgram.hasTtsVoice(v.id)).toBe(true)
    expect(deepgram.hasTtsVoice('aura-asteria-en')).toBe(false)
    expect(deepgram.hasTtsVoice(undefined)).toBe(false)
  })

  it('resolves the first pick the provider offers, then the default', () => {
    const deepgram = getVoiceProvider('deepgram')
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


describe('delegated conversation capability', () => {
  it('is provided by OpenAI and absent for the chained providers', () => {
    expect(getVoiceProvider('openai').getLiveConversation()).toBe(getVoiceProvider('openai'))
    expect(getVoiceProvider('deepgram').getLiveConversation()).toBeNull()
    expect(getVoiceProvider('platform').getLiveConversation()).toBeNull()
  })
})
