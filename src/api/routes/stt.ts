import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getVoiceSettings, type SttProvider } from '@shared/lib/config/settings'
import { getSttProvider } from '@shared/lib/stt'
import { DEFAULT_TTS_VOICE } from '@shared/lib/stt/tts-voices'
import { getVoiceAgentPrompt, type VoiceAgentPromptName } from '@shared/prompts/voice-agent'

const stt = new Hono()

stt.use('*', Authenticated())

// GET /api/stt/configured - Check if voice input is configured (available to all authenticated users)
stt.get('/configured', (c) => {
  const voiceSettings = getVoiceSettings()
  const provider = voiceSettings.sttProvider
  if (!provider) return c.json({ configured: false, supportsVoiceAgent: false, supportsTts: false })
  const sttProvider = getSttProvider(provider)
  const status = sttProvider.getApiKeyStatus()
  const configured = status.isConfigured
  return c.json({
    configured,
    supportsVoiceAgent: configured && sttProvider.supportsVoiceAgent(),
    supportsTts: configured && sttProvider.supportsTts(),
  })
})

stt.get('/token', async (c) => {
  try {
    const providerParam = c.req.query('provider')
    if (providerParam && providerParam !== 'deepgram' && providerParam !== 'openai' && providerParam !== 'platform') {
      return c.json({ error: `Invalid STT provider: ${providerParam}` }, 400)
    }

    const voiceSettings = getVoiceSettings()
    const provider: SttProvider | undefined = (providerParam as SttProvider) || voiceSettings.sttProvider

    if (!provider) {
      return c.json({ error: 'No STT provider configured. Set one in Settings > Voice.' }, 400)
    }

    const result = await getSttProvider(provider).getEphemeralToken()
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get STT credentials'
    console.error('Failed to get STT credentials:', error)
    return c.json({ error: message }, 500)
  }
})

stt.get('/voice-agent-prompt', (c) => {
  const name = c.req.query('name') as VoiceAgentPromptName | undefined
  if (!name || !['create-agent', 'improve-agent'].includes(name)) {
    return c.json({ error: 'Invalid prompt name. Use "create-agent" or "improve-agent".' }, 400)
  }
  try {
    const prompt = getVoiceAgentPrompt(name)
    return c.json({ prompt })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load voice agent prompt'
    return c.json({ error: message }, 500)
  }
})

stt.get('/voice-agent-token', async (c) => {
  try {
    const providerParam = c.req.query('provider')
    if (providerParam && providerParam !== 'deepgram' && providerParam !== 'openai' && providerParam !== 'platform') {
      return c.json({ error: `Invalid STT provider: ${providerParam}` }, 400)
    }

    const voiceSettings = getVoiceSettings()
    const provider: SttProvider | undefined = (providerParam as SttProvider) || voiceSettings.sttProvider

    if (!provider) {
      return c.json({ error: 'No STT provider configured. Set one in Settings > Voice.' }, 400)
    }

    const sttProvider = getSttProvider(provider)
    if (!sttProvider.supportsVoiceAgent()) {
      return c.json({ error: `Voice Agent not supported by ${provider}` }, 400)
    }

    const result = await sttProvider.getVoiceAgentToken()
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get Voice Agent credentials'
    console.error('Failed to get Voice Agent credentials:', error)
    return c.json({ error: message }, 500)
  }
})

// GET /api/stt/tts-token - Credentials for a client-side text-to-speech session,
// plus the voice to speak with (so the client needs no settings round-trip).
stt.get('/tts-token', async (c) => {
  try {
    const voiceSettings = getVoiceSettings()
    const provider = voiceSettings.sttProvider
    if (!provider) {
      return c.json({ error: 'No voice provider configured. Set one in Settings > Voice.' }, 400)
    }

    const sttProvider = getSttProvider(provider)
    if (!sttProvider.supportsTts()) {
      return c.json({ error: `Text-to-speech not supported by ${provider}` }, 400)
    }

    const result = await sttProvider.getTtsToken()
    return c.json({ ...result, voice: voiceSettings.ttsVoice ?? DEFAULT_TTS_VOICE })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get text-to-speech credentials'
    console.error('Failed to get text-to-speech credentials:', error)
    return c.json({ error: message }, 500)
  }
})

export default stt
