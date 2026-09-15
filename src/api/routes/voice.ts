import { Hono } from 'hono'
import { LiveSessionRegistry } from '@shared/lib/voice/live-session-registry'
import { z } from 'zod'
import { limitJsonBody, type LimitedJsonBodyEnv } from '../middleware/limit-json-body'
import { Authenticated } from '../middleware/auth'
import { getVoiceSettings, type VoiceProvider } from '@shared/lib/config/settings'
import { getVoiceProvider } from '@shared/lib/voice'
import { liveMappingSchema, voiceHistorySchema } from '@shared/lib/voice/live-types'
import { resolveTtsSpeed } from '@shared/lib/voice/tts-preferences'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { getVoiceAgentPrompt, type VoiceAgentPromptName } from '@shared/prompts/voice-agent'
import { captureException } from '@shared/lib/error-reporting'

const voice = new Hono<LimitedJsonBodyEnv>()

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
    conversationEngine: configured ? sttProvider.getConversationEngine() : null,
    supportsVoiceAgent: configured && sttProvider.supportsVoiceAgent(),
    supportsTts,
    voices: supportsTts ? sttProvider.getTtsVoices() : [],
    defaultVoice: supportsTts ? sttProvider.resolveTtsVoice(voiceSettings.ttsVoice) : undefined,
  })
})

// Live extends the existing OpenAI BYOK provider, independently of dictation
// and the voice-agent creation/feedback aids.
voice.use('/live/*', limitJsonBody(128 * 1024))
voice.use('/live/*', async (c, next) => {
  if (c.req.method !== 'DELETE' && getVoiceSettings().sttProvider !== 'openai') {
    return c.json({ error: 'Select OpenAI in Settings > Voice to use Live.' }, 400)
  }
  return next()
})
// Opaque, user-bound handles prevent one user from closing another's call.
const liveSessions = new LiveSessionRegistry((id) => getVoiceProvider('openai').closeLiveSession(id))
const pendingLiveStarts = new Map<string, number>()
const liveSessionSchema = z.object({ sdp: z.string().min(1).max(64000), history: voiceHistorySchema })
voice.post('/live/session', async (c) => {
  const parsed = liveSessionSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid Live session request.' }, 400)
  const owner = getCurrentUserId(c)
  const pending = pendingLiveStarts.get(owner) ?? 0
  if (pending + liveSessions.activeCount(owner) >= 4) {
    return c.json({ error: 'Close an existing voice session before starting another.' }, 429)
  }
  pendingLiveStarts.set(owner, pending + 1)
  try {
    const provider = getVoiceProvider('openai')
    const answer = await provider.createLiveSession(parsed.data.sdp, parsed.data.history)
    const registered = liveSessions.add(owner, answer.session.id)
    if (c.req.raw.signal.aborted) {
      await liveSessions.release(registered.handle, owner)
      return c.json({ error: 'Voice connection request was cancelled.' }, 408)
    }
    return c.json({ ...answer, ...registered }, 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to create Live session.' }, 502)
  } finally {
    const remaining = (pendingLiveStarts.get(owner) ?? 1) - 1
    if (remaining) pendingLiveStarts.set(owner, remaining)
    else pendingLiveStarts.delete(owner)
  }
})
voice.delete('/live/session/:handle', async (c) => {
  const result = await liveSessions.release(c.req.param('handle'), getCurrentUserId(c))
  if (result === 'missing') return c.json({ error: 'Voice session not found.' }, 404)
  return c.json({ closed: result === 'closed', closing: result === 'closing' }, result === 'closed' ? 200 : 202)
})
voice.post('/live/map', async (c) => {
  const parsed = liveMappingSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid Live mapping request.' }, 400)
  try {
    const provider = getVoiceProvider('openai')
    return c.json(await provider.mapLiveConversation(parsed.data, c.req.raw.signal))
  } catch {
    return c.json({ error: 'Voice mapping failed. Check the configured summarizer and try again.' }, 502)
  }
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
