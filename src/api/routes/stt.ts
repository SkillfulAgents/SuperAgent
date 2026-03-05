import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { getVoiceSettings, type SttProvider } from '@shared/lib/config/settings'
import { getSttProvider } from '@shared/lib/stt'

const stt = new Hono()

stt.use('*', Authenticated())

stt.get('/token', async (c) => {
  try {
    const providerParam = c.req.query('provider')
    if (providerParam && providerParam !== 'deepgram' && providerParam !== 'openai') {
      return c.json({ error: `Invalid STT provider: ${providerParam}` }, 400)
    }

    const voiceSettings = getVoiceSettings()
    // providerParam is already validated above to be 'deepgram' | 'openai' | undefined
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

export default stt
