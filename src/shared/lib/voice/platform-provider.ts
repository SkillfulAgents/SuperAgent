import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { OpenaiVoiceProvider, type OpenaiVoiceMessages } from './openai-provider'
import type { ApiKeyStatus } from '../config/settings'

const PLATFORM_MESSAGES: OpenaiVoiceMessages = {
  missingKey: 'Connect your platform account in Settings > Account to use voice.',
  authFailed: 'Platform voice authentication failed. Sign in again and check your voice access.',
  quotaExceeded: 'Voice is unavailable right now: workspace balance or rate limit reached. Check billing and try again shortly.',
  liveSessionHint: 'Check your platform voice access and workspace balance.',
}

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
    return PLATFORM_MESSAGES
  }

  // The proxy exposes no /models; a short-lived client secret proves the token has voice access.
  override async validateKey(platformToken: string): Promise<{ valid: boolean; error?: string }> {
    try {
      await this.mintClientSecret(platformToken, {
        expires_after: { anchor: 'created_at', seconds: 60 },
        session: { type: 'transcription' },
      })
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  }
}
