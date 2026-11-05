import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { OpenaiVoiceProvider } from './openai-provider'
import { PLATFORM_VOICE_MESSAGES, type OpenaiVoiceMessages } from './openai-voice-messages'
import type { ApiKeyStatus } from '../config/settings'

/** OpenAI voice through the platform proxy: same endpoints, platform token instead of a BYOK key. */
export class PlatformVoiceProvider extends OpenaiVoiceProvider {
  override readonly id = 'platform' as const
  override readonly name = 'Platform'

  override async getApiKeyStatus(): Promise<ApiKeyStatus> {
    const token = await getPlatformAccessToken()
    if (token) return { isConfigured: true, source: 'settings' }
    return { isConfigured: false, source: 'none' }
  }

  override async getEffectiveApiKey(): Promise<string | undefined> {
    return (await getPlatformAccessToken()) ?? undefined
  }

  protected override apiBaseUrl(): string {
    return `${getPlatformProxyBaseUrl()}/v1/openai`
  }

  protected override messages(): OpenaiVoiceMessages {
    return PLATFORM_VOICE_MESSAGES
  }
}
