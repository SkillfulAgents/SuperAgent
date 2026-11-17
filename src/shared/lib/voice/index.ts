export { BaseVoiceProvider } from './voice-provider'
export { DeepgramVoiceProvider } from './deepgram-provider'
export { OpenaiVoiceProvider } from './openai-provider'
export { PlatformVoiceProvider } from './platform-provider'

import type { VoiceProvider } from '../config/settings'
import { getSettings } from '../config/settings'
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
export async function getConfiguredVoiceProvider(): Promise<BaseVoiceProvider | null> {
  // One read: the selection and its key status come from the same settings.
  const settings = await getSettings()
  const selected = settings.voice?.sttProvider
  if (!selected) return null
  const provider = providers[selected]
  if (!provider) return null
  if (!provider.apiKeyStatusFrom(settings).isConfigured) return null
  return provider
}
