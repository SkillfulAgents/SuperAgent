export { BaseVoiceProvider } from './voice-provider'
export { DeepgramVoiceProvider } from './deepgram-provider'
export { OpenaiVoiceProvider } from './openai-provider'
export { PlatformVoiceProvider } from './platform-provider'

import type { VoiceProvider } from '../config/settings'
import { getVoiceSettings } from '../config/settings'
import { BaseVoiceProvider } from './voice-provider'
import { DeepgramVoiceProvider } from './deepgram-provider'
import { OpenaiVoiceProvider } from './openai-provider'
import { PlatformVoiceProvider } from './platform-provider'

const providers = {
  deepgram: new DeepgramVoiceProvider(),
  openai: new OpenaiVoiceProvider(),
  platform: new PlatformVoiceProvider(),
} satisfies Record<VoiceProvider, BaseVoiceProvider>

export function getVoiceProvider<T extends VoiceProvider>(id: T): typeof providers[T] {
  const provider = providers[id]
  if (!provider) {
    throw new Error(`Unknown voice provider: ${id}`)
  }
  return provider
}

/**
 * Returns the configured voice provider if one is set up and has an API key,
 * or null if voice is not configured.
 */
export function getConfiguredVoiceProvider(): BaseVoiceProvider | null {
  const voice = getVoiceSettings()
  if (!voice.sttProvider) return null
  const provider = providers[voice.sttProvider]
  if (!provider) return null
  const status = provider.getApiKeyStatus()
  if (!status.isConfigured) return null
  return provider
}
