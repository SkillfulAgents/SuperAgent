import { Hono, type Context } from 'hono'
import { ttsSynthesisSchema } from '@shared/lib/voice/tts-types'
import { VoiceProviderError } from '@shared/lib/voice/provider-error'
import { LiveSessionRegistry } from '@shared/lib/voice/live-session-registry'
import { z } from 'zod'
import { limitJsonBody, type LimitedJsonBodyEnv } from '../middleware/limit-json-body'
import { Authenticated, ResolveAgent, AgentUser, getAgentId } from '../middleware/auth'
import { getVoiceSettings, getAgentCapabilitySettings, type VoiceProvider } from '@shared/lib/config/settings'
import { getVoiceProvider } from '@shared/lib/voice'
import { liveMappingSchema, voiceHistorySchema, type LiveAgentContext } from '@shared/lib/voice/live-types'
import { VOICE_LIVE_BODY_MAX_BYTES } from '@shared/lib/voice/conversation-types'
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

// Resolve capability through the configured provider; transport and mapping
// behavior stay in its implementation.
voice.use('/live/*', limitJsonBody(VOICE_LIVE_BODY_MAX_BYTES))
function requireConfiguredProvider(c: Context<LimitedJsonBodyEnv>, selected = getVoiceSettings().sttProvider) {
  if (!selected) return c.json({ error: 'No voice provider configured. Set one in Settings > Voice.' }, 400)
  return getVoiceProvider(selected)
}

function requireLiveConversation(c: Context<LimitedJsonBodyEnv>, operation: string) {
  const provider = requireConfiguredProvider(c)
  if (provider instanceof Response) return provider
  const conversation = provider.getLiveConversation()
  if (!conversation) return c.json({
    error: `${operation} not supported with current configured voice provider: ${provider.name}`,
  }, 400)
  return { provider, conversation }
}

function ttsError(c: Context<LimitedJsonBodyEnv>, error: unknown, fallback: string) {
  if (error instanceof VoiceProviderError && error.status === 400) return c.json({ error: error.message }, 400)
  console.error(fallback, error)
  return c.json({ error: error instanceof VoiceProviderError ? error.message : fallback }, 502)
}
// Each owned handle retains its creating provider's cleanup operation, including
// retries and expiry after the configured provider changes.
const liveSessions = new LiveSessionRegistry()
const pendingLiveStarts = new Map<string, number>()
const liveSessionSchema = z.object({ sdp: z.string().min(1).max(64000), history: voiceHistorySchema })
async function createLiveSession(c: Context<LimitedJsonBodyEnv>) {
  const ready = requireLiveConversation(c, 'Live session creation')
  if (ready instanceof Response) return ready
  const { provider, conversation } = ready
  const parsed = liveSessionSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid Live session request.' }, 400)
  const owner = getCurrentUserId(c)
  const pending = pendingLiveStarts.get(owner) ?? 0
  if (pending + liveSessions.activeCount(owner) >= 4) {
    return c.json({ error: 'Close an existing voice session before starting another.' }, 429)
  }
  pendingLiveStarts.set(owner, pending + 1)
  try {
    let agentContext: LiveAgentContext | undefined
    if (c.req.param('id')) {
      // Only the protected route resolves an agent. Load instructions after ACL
      // checks, and never let browser-supplied prompt fields reach the provider.
      const { getAgent } = await import('@shared/lib/services/agent-service')
      const agent = await getAgent(getAgentId(c))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)
      agentContext = {
        name: agent.frontmatter.name,
        description: agent.frontmatter.description,
        instructions: agent.instructions,
        capabilityPolicies: getAgentCapabilitySettings(),
      }
    }
    const apiKey = provider.getEffectiveApiKey()
    const answer = agentContext
      ? await conversation.createLiveSession(parsed.data.sdp, parsed.data.history, agentContext)
      : await conversation.createLiveSession(parsed.data.sdp, parsed.data.history)
    const registered = liveSessions.add(owner, () => conversation.closeLiveSession(answer.session.id, apiKey))
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
}
// Keep generic startup for older renderers; current conversations use the ACL-protected route.
voice.post('/live/session', createLiveSession)
voice.post('/live/agents/:id/session', ResolveAgent(), AgentUser(), createLiveSession)
voice.delete('/live/session/:handle', async (c) => {
  const result = await liveSessions.release(c.req.param('handle'), getCurrentUserId(c))
  if (result === 'missing') return c.json({ error: 'Voice session not found.' }, 404)
  return c.json({ closed: result === 'closed', closing: result === 'closing' }, result === 'closed' ? 200 : 202)
})
voice.post('/live/map', async (c) => {
  const ready = requireLiveConversation(c, 'Live conversation mapping')
  if (ready instanceof Response) return ready
  const parsed = liveMappingSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid Live mapping request.' }, 400)
  try {
    return c.json(await ready.conversation.mapLiveConversation(parsed.data, c.req.raw.signal))
  } catch {
    return c.json({ error: 'Voice mapping failed. Please try again.' }, 502)
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

    const configured = requireConfiguredProvider(c, provider)
    if (configured instanceof Response) return configured
    const result = await configured.getEphemeralToken()
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

    const sttProvider = requireConfiguredProvider(c, provider)
    if (sttProvider instanceof Response) return sttProvider
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

// Keep the old response shape for cached/remote renderers, using the same setup path.
async function initializeTts(c: Context<LimitedJsonBodyEnv>, legacy = false) {
  const provider = requireConfiguredProvider(c)
  if (provider instanceof Response) return provider
  try {
    const connection = await provider.getTtsConnection()
    const own = getUserSettings(getCurrentUserId(c)).voice
    const preferences = { provider: provider.id,
      voice: provider.resolveTtsVoice(own?.ttsVoice, getVoiceSettings().ttsVoice),
      speed: resolveTtsSpeed(own?.ttsSpeed),
    }
    if (!legacy) return c.json({ ...preferences, connection })
    if (connection.transport !== 'websocket') return c.json({ error: 'This voice provider requires an updated client. Reload the app to use read-aloud.' }, 400)
    return c.json({ ...preferences, token: connection.token })
  } catch (error) {
    return ttsError(c, error, `Could not initialize ${provider.name} text-to-speech. Please try again.`)
  }
}

// Transport-neutral initialization. API keys never reach the renderer.
voice.get('/tts-session', (c) => initializeTts(c))
voice.get('/tts-token', (c) => initializeTts(c, true))

voice.post('/tts', limitJsonBody(32 * 1024), async (c) => {
  const parsed = ttsSynthesisSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid speech synthesis request.' }, 400)
  const provider = requireConfiguredProvider(c)
  if (provider instanceof Response) return provider
  // An already-open reader must not silently synthesize against a different account/provider.
  if (parsed.data.provider !== provider.id) return c.json({ error: 'Voice provider changed. Restart read-aloud.' }, 409)
  const synthesis = provider.getTtsSynthesis()
  if (!synthesis) return c.json({ error: `Server-side speech synthesis not supported with current configured voice provider: ${provider.name}` }, 400)
  if (!provider.hasTtsVoice(parsed.data.voice)) return c.json({ error: 'Invalid voice for the configured provider.' }, 400)
  try {
    const { text, voice: selectedVoice, speed } = parsed.data
    const audio = await synthesis.synthesizeSpeech({ text, voice: selectedVoice, speed }, c.req.raw.signal)
    return new Response(audio, { headers: { 'Content-Type': 'audio/pcm', 'Cache-Control': 'no-store' } })
  } catch (error) {
    return ttsError(c, error, 'Speech synthesis failed. Check your voice provider access and try again.')
  }
})

export default voice
