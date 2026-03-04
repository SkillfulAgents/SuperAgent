import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import {
  getEffectiveDeepgramApiKey,
  getEffectiveOpenaiApiKey,
  getVoiceSettings,
  type SttProvider,
} from '@shared/lib/config/settings'
import { db } from '@shared/lib/db'
import { sttUsage } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { randomUUID } from 'crypto'

// Cost per millisecond in micro-dollars (1 micro-dollar = 1/1,000,000 USD)
// Deepgram Nova 3: $4.30 / 1000 min = $0.00007167 / sec = 71.67 µ$ / sec = 0.07167 µ$ / ms
// OpenAI gpt-4o-mini-transcribe: $3.00 / 1000 min = $0.00005 / sec = 50 µ$ / sec = 0.05 µ$ / ms
const STT_PRICING: Record<SttProvider, { model: string; microDollarsPerMs: number }> = {
  deepgram: { model: 'nova-3', microDollarsPerMs: 0.07167 },
  openai: { model: 'gpt-4o-mini-transcribe', microDollarsPerMs: 0.05 },
}

const stt = new Hono()

stt.use('*', Authenticated())

stt.get('/token', async (c) => {
  try {
    const voiceSettings = getVoiceSettings()
    const provider = (c.req.query('provider') as SttProvider) || voiceSettings.sttProvider

    if (!provider) {
      return c.json({ error: 'No STT provider configured. Set one in Settings > Voice.' }, 400)
    }

    let apiKey: string | undefined
    switch (provider) {
      case 'deepgram':
        apiKey = getEffectiveDeepgramApiKey()
        break
      case 'openai':
        apiKey = getEffectiveOpenaiApiKey()
        break
      default:
        return c.json({ error: `Unknown STT provider: ${provider}` }, 400)
    }

    if (!apiKey) {
      return c.json({ error: `No API key configured for ${provider}. Add one in Settings > Voice.` }, 400)
    }

    return c.json({ provider, token: apiKey })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to get STT credentials'
    console.error('Failed to get STT credentials:', error)
    return c.json({ error: message }, 500)
  }
})

stt.post('/usage', async (c) => {
  try {
    const body = await c.req.json<{ provider: SttProvider; durationMs: number; agentSlug?: string }>()
    const { provider, durationMs, agentSlug } = body

    if (!provider || !STT_PRICING[provider]) {
      return c.json({ error: 'Invalid provider' }, 400)
    }
    if (!durationMs || durationMs <= 0 || durationMs > 14_400_000) { // add 4 hour limit
      return c.json({ error: 'Invalid duration' }, 400)
    }

    const pricing = STT_PRICING[provider]
    const costMicro = Math.round(durationMs * pricing.microDollarsPerMs)

    const userId = isAuthMode() ? getCurrentUserId(c) : null

    await db.insert(sttUsage).values({
      id: randomUUID(),
      provider,
      model: pricing.model,
      durationMs,
      cost: costMicro,
      agentSlug: agentSlug || null,
      userId,
      createdAt: new Date(),
    })

    return c.json({ ok: true, model: pricing.model, costUsd: costMicro / 1_000_000 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to record STT usage'
    console.error('Failed to record STT usage:', error)
    return c.json({ error: message }, 500)
  }
})

export default stt
