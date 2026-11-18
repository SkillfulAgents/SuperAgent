import { Hono, type Context } from 'hono'
import { ttsSynthesisSchema } from '@shared/lib/voice/tts-types'
import { VoiceProviderError } from '@shared/lib/voice/provider-error'
import { liveSessions } from '@shared/lib/voice/live-sessions'
import { z } from 'zod'
import { limitJsonBody, type LimitedJsonBodyEnv } from '../middleware/limit-json-body'
import { Authenticated, ResolveAgent, AgentUser, getAgentId } from '../middleware/auth'
import { getSettings, type AppSettings, type VoiceProvider } from '@shared/lib/config/settings'
import { DEFAULT_AGENT_CAPABILITIES } from '@shared/lib/config/capability-policy-schema'
import { getVoiceProvider } from '@shared/lib/voice'
import { liveMappingSchema, voiceHistorySchema, type LiveAgentContext } from '@shared/lib/voice/live-types'
import { resolveLiveConversationSetting } from '@shared/lib/agent-integrations/live-setting'
import { VOICE_LIVE_BODY_MAX_BYTES } from '@shared/lib/voice/conversation-types'
import { resolveTtsSpeed } from '@shared/lib/voice/tts-preferences'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { getUserSettings } from '@shared/lib/services/user-settings-service'
import { captureException } from '@shared/lib/error-reporting'
import { background } from '@shared/lib/background'

const voice = new Hono<LimitedJsonBodyEnv>()

voice.use('*', Authenticated())

// GET /api/voice/configured - Check if voice input is configured (available to all authenticated users).
// Also carries the provider's read-aloud voices and the deployment's default
// among them: the settings endpoint is admin-only, and members need both to
// fill their voice picker and label "Workspace Default".
// Every handler below reads the settings once and answers from that read.
voice.get('/configured', async (c) => {
  const settings = await getSettings()
  const voiceSettings = settings.voice ?? {}
  const provider = voiceSettings.sttProvider
  if (!provider) return c.json({ configured: false, supportsTts: false, voices: [] })
  const sttProvider = getVoiceProvider(provider)
  const configured = sttProvider.apiKeyStatusFrom(settings).isConfigured
  const supportsTts = configured && sttProvider.supportsTts()
  // Live sessions (meetings) speak with the provider's Live voices, a different list from read-aloud.
  const live = configured ? sttProvider.getLiveConversation() : null
  return c.json({
    configured,
    conversationEngine: configured ? sttProvider.getConversationEngine() : null,
    supportsTts,
    voices: supportsTts ? sttProvider.getTtsVoices() : [],
    defaultVoice: supportsTts ? sttProvider.resolveTtsVoice(voiceSettings.ttsVoice) : undefined,
    liveVoices: live?.getLiveVoices() ?? [],
    liveDefaultVoice: live?.resolveLiveVoice() ?? undefined,
  })
})

// Resolve capability through the configured provider; transport and mapping
// behavior stay in its implementation.
voice.use('/live/*', limitJsonBody(VOICE_LIVE_BODY_MAX_BYTES))
function requireConfiguredProvider(c: Context<LimitedJsonBodyEnv>, settings: AppSettings, provider?: VoiceProvider) {
  const selected = provider ?? settings.voice?.sttProvider
  if (!selected) return c.json({ error: 'No voice provider configured. Set one in Settings > Voice.' }, 400)
  return getVoiceProvider(selected)
}

function requireLiveConversation(c: Context<LimitedJsonBodyEnv>, settings: AppSettings, operation: string) {
  const provider = requireConfiguredProvider(c, settings)
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
// `sessionId` lets the host look up where the conversation is taking place (a
// meeting); it never carries instructions of its own.
const liveSessionSchema = z.object({ sdp: z.string().min(1).max(64000), history: voiceHistorySchema, sessionId: z.string().min(1).max(200).optional() })
async function createLiveSession(c: Context<LimitedJsonBodyEnv>) {
  const settings = await getSettings()
  const ready = requireLiveConversation(c, settings, 'Live session creation')
  if (ready instanceof Response) return ready
  const { provider, conversation } = ready
  const parsed = liveSessionSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid Live session request.' }, 400)
  const owner = getCurrentUserId(c)
  // Pending and active sessions count together, in every process.
  const reservation = await liveSessions.reserve(owner, provider.id)
  if (!reservation) return c.json({ error: 'Close an existing voice session before starting another.' }, 429)
  // A request cancelled while the provider works gives its place back at once;
  // if the provider still creates the session, it is then hung up.
  const signal = c.req.raw.signal
  const cancel = () => background(reservation.end(), { name: 'voice.cancel-live-reservation' })
  signal.addEventListener('abort', cancel, { once: true })
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
        capabilityPolicies: settings.agentCapabilities ?? DEFAULT_AGENT_CAPABILITIES,
        // A session an integration owns (a meeting) changes when the model may speak.
        setting: parsed.data.sessionId ? await resolveLiveConversationSetting(getAgentId(c), parsed.data.sessionId) : undefined,
      }
    }
    // Created with this request's settings read (key and summarizer); hung up
    // later with the provider's key as configured then (`live-sessions.ts`).
    const answer = await conversation.createLiveSession(parsed.data.sdp, parsed.data.history, agentContext, { settings })
    // Hangs the session up itself when the reservation is gone by now.
    const started = await reservation.start(answer.session.id)
    if (!started) {
      return c.json({ error: signal.aborted ? 'Voice connection request was cancelled.' : 'Voice connection request timed out. Try again.' }, 408)
    }
    if (signal.aborted) {
      await liveSessions.release(started.handle, owner)
      return c.json({ error: 'Voice connection request was cancelled.' }, 408)
    }
    return c.json({ ...answer, ...started }, 201)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to create Live session.' }, 502)
  } finally {
    signal.removeEventListener('abort', cancel)
    // A start that failed frees its place here.
    await reservation.end()
  }
}
// Keep generic startup for older renderers; current conversations use the ACL-protected route.
voice.post('/live/session', createLiveSession)
voice.post('/live/agents/:id/session', ResolveAgent(), AgentUser(), createLiveSession)
// Any process can release a session: the handle is looked up in the user's own record.
voice.delete('/live/session/:handle', async (c) => {
  const result = await liveSessions.release(c.req.param('handle'), getCurrentUserId(c))
  if (result === 'missing') return c.json({ error: 'Voice session not found.' }, 404)
  return c.json({ closed: result === 'closed', closing: result === 'closing' }, result === 'closed' ? 200 : 202)
})
voice.post('/live/map', async (c) => {
  // Per utterance: the provider and the summarizer it maps with, from one read.
  const settings = await getSettings()
  const ready = requireLiveConversation(c, settings, 'Live conversation mapping')
  if (ready instanceof Response) return ready
  const parsed = liveMappingSchema.safeParse(c.get('limitedJsonBody'))
  if (!parsed.success) return c.json({ error: 'Invalid Live mapping request.' }, 400)
  try {
    return c.json(await ready.conversation.mapLiveConversation(parsed.data, c.req.raw.signal, settings))
  } catch (error) {
    // The renderer only sees the generic line; the reason belongs in the host log.
    console.error('[voice] Live mapping failed:', error)
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

    const settings = await getSettings()
    provider = (providerParam as VoiceProvider) || settings.voice?.sttProvider

    const configured = requireConfiguredProvider(c, settings, provider)
    if (configured instanceof Response) return configured
    const result = await configured.getEphemeralToken(settings)
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

// Keep the old response shape for cached/remote renderers, using the same setup path.
async function initializeTts(c: Context<LimitedJsonBodyEnv>, legacy = false) {
  const settings = await getSettings()
  const provider = requireConfiguredProvider(c, settings)
  if (provider instanceof Response) return provider
  try {
    const connection = await provider.getTtsConnection(settings)
    const own = (await getUserSettings(getCurrentUserId(c))).voice
    const preferences = { provider: provider.id,
      voice: provider.resolveTtsVoice(own?.ttsVoice, settings.voice?.ttsVoice),
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
  const settings = await getSettings()
  const provider = requireConfiguredProvider(c, settings)
  if (provider instanceof Response) return provider
  // An already-open reader must not silently synthesize against a different account/provider.
  if (parsed.data.provider !== provider.id) return c.json({ error: 'Voice provider changed. Restart read-aloud.' }, 409)
  const synthesis = provider.getTtsSynthesis()
  if (!synthesis) return c.json({ error: `Server-side speech synthesis not supported with current configured voice provider: ${provider.name}` }, 400)
  if (!provider.hasTtsVoice(parsed.data.voice)) return c.json({ error: 'Invalid voice for the configured provider.' }, 400)
  try {
    const { text, voice: selectedVoice, speed } = parsed.data
    const audio = await synthesis.synthesizeSpeech({ text, voice: selectedVoice, speed }, c.req.raw.signal, settings)
    return new Response(audio, { headers: { 'Content-Type': 'audio/pcm', 'Cache-Control': 'no-store' } })
  } catch (error) {
    return ttsError(c, error, 'Speech synthesis failed. Check your voice provider access and try again.')
  }
})

export default voice
