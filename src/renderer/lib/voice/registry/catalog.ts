import type { VoiceProvider } from '@shared/lib/config/settings'
import type { VoiceConversationEngine } from '../contracts/conversation'
import type { ApiKeyProvider, VoiceProviderKeyConfig, VoiceProviderOption } from '../contracts/presentation'
import { deepgramOption, deepgramKeyConfig } from '../providers/deepgram/presentation'
import { openaiOption, openaiKeyConfig, openaiConversationNotice } from '../providers/openai/presentation'
export type { ApiKeyProvider } from '../contracts/presentation'

// Which vendor backs the platform provider is the host's decision; the
// renderer only labels the option, so it lives with the catalog, not a vendor.
const platformOption: VoiceProviderOption = {
  value: 'platform', label: 'Platform', model: 'Nova 3',
  note: 'Uses Deepgram via your platform connection. No API key required.', platformOnly: true,
}

/** Presentation metadata stays lightweight: importing settings never loads audio engines. */
const options = {
  platform: platformOption,
  deepgram: deepgramOption,
  openai: openaiOption,
} satisfies Record<VoiceProvider, VoiceProviderOption>
/** In display order. Every provider must appear: the record above makes that a type error. */
export const VOICE_PROVIDER_OPTIONS: readonly VoiceProviderOption[] = [options.platform, options.deepgram, options.openai]
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
