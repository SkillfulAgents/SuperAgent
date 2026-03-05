import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import {
  getEffectiveDeepgramApiKey,
  getEffectiveOpenaiApiKey,
  getVoiceSettings,
  type SttProvider,
} from '@shared/lib/config/settings'

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

export default stt
