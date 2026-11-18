import { platformAccessTokenFrom } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { OpenaiVoiceProvider } from './openai-provider'
import { PLATFORM_VOICE_MESSAGES, type OpenaiVoiceMessages } from './openai-voice-messages'
import type { ApiKeyStatus } from '../config/settings'
import type { VoiceProviderSettings } from './voice-provider'

/** OpenAI voice through the platform proxy: same endpoints, platform token instead of a BYOK key. */
export class PlatformVoiceProvider extends OpenaiVoiceProvider {
  override readonly id = 'platform' as const
  override readonly name = 'Platform'

  override apiKeyStatusFrom(settings: VoiceProviderSettings): ApiKeyStatus {
    if (platformAccessTokenFrom(settings)) return { isConfigured: true, source: 'settings' }
    return { isConfigured: false, source: 'none' }
  }

  override effectiveApiKeyFrom(settings: VoiceProviderSettings): string | undefined {
    return platformAccessTokenFrom(settings) ?? undefined
  }

  protected override apiBaseUrl(): string {
    return `${getPlatformProxyBaseUrl()}/v1/openai`
  }

  protected override messages(): OpenaiVoiceMessages {
    return PLATFORM_VOICE_MESSAGES
  }
}
