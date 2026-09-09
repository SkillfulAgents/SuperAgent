import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getVoiceSettings, type VoiceProvider } from '@shared/lib/config/settings'
import { getVoiceProvider } from '@shared/lib/voice'
import { resolveTtsSpeed } from '@shared/lib/voice/tts-preferences'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { getVoiceAgentPrompt, type VoiceAgentPromptName } from '@shared/prompts/voice-agent'
import { captureException } from '@shared/lib/error-reporting'

const voice = new Hono()

voice.use('*', Authenticated())

// GET /api/voice/configured - Check if voice input is configured (available to all authenticated users).
// Also carries the provider's read-aloud voices and the deployment's default
// among them: the settings endpoint is admin-only, and members need both to
// fill their voice picker and label "Workspace Default".
voice.get('/configured', (c) => {
  const voiceSettings = getVoiceSettings()
  const provider = voiceSettings.sttProvider
  if (!provider) return c.json({ configured: false, supportsVoiceAgent: false, supportsTts: false, voices: [] })
  const sttProvider = getVoiceProvider(provider)
  const status = sttProvider.getApiKeyStatus()
  const configured = status.isConfigured
  const supportsTts = configured && sttProvider.supportsTts()
  return c.json({
    configured,
    supportsVoiceAgent: configured && sttProvider.supportsVoiceAgent(),
    supportsTts,
    voices: supportsTts ? sttProvider.getTtsVoices() : [],
    defaultVoice: supportsTts ? sttProvider.resolveTtsVoice(voiceSettings.ttsVoice) : undefined,
  })
})

voice.get('/token', async (c) => {
  let provider: VoiceProvider | undefined
  try {
    const providerParam = c.req.query('provider')
    if (providerParam && providerParam !== 'deepgram' && providerParam !== 'openai' && providerParam !== 'platform') {
      return c.json({ error: `Invalid voice provider: ${providerParam}` }, 400)
    }

    const voiceSettings = getVoiceSettings()
    provider = (providerParam as VoiceProvider) || voiceSettings.sttProvider

    if (!provider) {
      return c.json({ error: 'No voice provider configured. Set one in Settings > Voice.' }, 400)
    }

    const result = await getVoiceProvider(provider).getEphemeralToken()
    return c.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get STT credentials'
    console.error('Failed to get STT credentials:', error)
    // The one server-side step of dictation: a failure here means nobody on
    // this deployment can dictate, so it belongs in the error tracker.
    captureException(error, {
      tags: { component: 'voice', operation: 'stt-token', provider: provider ?? 'none' },
    })
    return c.json({ error: message }, 500)
  }
})

voice.get('/voice-agent-prompt', (c) => {
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

voice.get('/voice-agent-token', async (c) => {
  try {
    const providerParam = c.req.query('provider')
    if (providerParam && providerParam !== 'deepgram' && providerParam !== 'openai' && providerParam !== 'platform') {
      return c.json({ error: `Invalid voice provider: ${providerParam}` }, 400)
    }

    const voiceSettings = getVoiceSettings()
    const provider: VoiceProvider | undefined = (providerParam as VoiceProvider) || voiceSettings.sttProvider

    if (!provider) {
      return c.json({ error: 'No voice provider configured. Set one in Settings > Voice.' }, 400)
    }

    const sttProvider = getVoiceProvider(provider)
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

// GET /api/voice/tts-token - Credentials for a client-side text-to-speech session,
// plus the voice and speed to speak with: the caller's own preferences, then
// the deployment default (so the client needs no settings round-trip).
voice.get('/tts-token', async (c) => {
  try {
    const voiceSettings = getVoiceSettings()
    const provider = voiceSettings.sttProvider
    if (!provider) {
      return c.json({ error: 'No voice provider configured. Set one in Settings > Voice.' }, 400)
    }

    const sttProvider = getVoiceProvider(provider)
    if (!sttProvider.supportsTts()) {
      return c.json({ error: `Text-to-speech not supported by ${provider}` }, 400)
    }

    const result = await sttProvider.getTtsToken()
    const own = getUserSettings(getCurrentUserId(c)).voice
    return c.json({
      ...result,
      voice: sttProvider.resolveTtsVoice(own?.ttsVoice, voiceSettings.ttsVoice),
      speed: resolveTtsSpeed(own?.ttsSpeed),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get text-to-speech credentials'
    console.error('Failed to get text-to-speech credentials:', error)
    return c.json({ error: message }, 500)
  }
})

export default voice
