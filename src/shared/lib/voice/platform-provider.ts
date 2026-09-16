import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { OpenaiVoiceProvider } from './openai-provider'
import { PLATFORM_VOICE_MESSAGES, type OpenaiVoiceMessages } from './openai-voice-messages'
import type { ApiKeyStatus } from '../config/settings'

/** OpenAI voice through the platform proxy: same endpoints, platform token instead of a BYOK key. */
export class PlatformVoiceProvider extends OpenaiVoiceProvider {
  override readonly id = 'platform' as const
  override readonly name = 'Platform'

  override getApiKeyStatus(): ApiKeyStatus {
    const token = getPlatformAccessToken()
    if (token) return { isConfigured: true, source: 'settings' }
    return { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? undefined
  }

  protected override apiBaseUrl(): string {
    return `${getPlatformProxyBaseUrl()}/v1/openai`
  }

  protected override messages(): OpenaiVoiceMessages {
    return PLATFORM_VOICE_MESSAGES
  }
}
