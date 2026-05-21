export { BaseSttProvider } from './stt-provider'
export { DeepgramSttProvider } from './deepgram-provider'
export { OpenaiSttProvider } from './openai-provider'
export { PlatformSttProvider } from './platform-provider'

import type { SttProvider } from '../config/settings'
import { getVoiceSettings } from '../config/settings'
import { BaseSttProvider } from './stt-provider'
import { DeepgramSttProvider } from './deepgram-provider'
import { OpenaiSttProvider } from './openai-provider'
import { PlatformSttProvider } from './platform-provider'

const providers: Record<SttProvider, BaseSttProvider> = {
  deepgram: new DeepgramSttProvider(),
  openai: new OpenaiSttProvider(),
  platform: new PlatformSttProvider(),
}

export function getSttProvider(id: SttProvider): BaseSttProvider {
  const provider = providers[id]
  if (!provider) {
    throw new Error(`Unknown STT provider: ${id}`)
  }
  return provider
}

/**
 * Returns the configured STT provider if one is set up and has an API key,
 * or null if voice/STT is not configured.
 */
export function getConfiguredSttProvider(): BaseSttProvider | null {
  const voice = getVoiceSettings()
  if (!voice.sttProvider) return null
  const provider = providers[voice.sttProvider]
  if (!provider) return null
  const status = provider.getApiKeyStatus()
  if (!status.isConfigured) return null
  return provider
}
