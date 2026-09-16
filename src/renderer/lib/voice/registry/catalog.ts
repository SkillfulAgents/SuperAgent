import type { VoiceProvider } from '@shared/lib/config/settings'
import type { VoiceConversationEngine } from '../contracts/conversation'
import type { ApiKeyProvider, VoiceProviderKeyConfig } from '../contracts/presentation'
import { deepgramOption, platformOption, deepgramKeyConfig } from '../providers/deepgram/presentation'
import { openaiOption, openaiKeyConfig, openaiConversationNotice } from '../providers/openai/presentation'
export type { ApiKeyProvider } from '../contracts/presentation'

/** Presentation metadata stays lightweight: importing settings never loads audio engines. */
export const VOICE_PROVIDERS = [platformOption, deepgramOption, openaiOption]
export const PROVIDER_CONFIG: Record<ApiKeyProvider, VoiceProviderKeyConfig> = {
  deepgram: deepgramKeyConfig,
  openai: openaiKeyConfig,
}
export function isApiKeyProvider(provider: VoiceProvider): provider is ApiKeyProvider {
  return Object.hasOwn(PROVIDER_CONFIG, provider)
}
export function getConversationNotice(engine: VoiceConversationEngine | null): string | null {
  return engine === 'openai-live' ? openaiConversationNotice : null
}
