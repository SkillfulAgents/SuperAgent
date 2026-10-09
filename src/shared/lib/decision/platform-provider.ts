import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import type { ApiKeyStatus } from '../config/settings'
import { OpenaiDecisionProvider } from './openai-provider'

/** OpenAI Decisions through the platform proxy: same request, platform token instead of a BYOK key. */
export class PlatformDecisionProvider extends OpenaiDecisionProvider {
  override readonly id = 'platform' as const
  override readonly name = 'Platform'

  override getApiKeyStatus(): ApiKeyStatus {
    return getPlatformAccessToken() ? { isConfigured: true, source: 'settings' } : { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? undefined
  }

  protected override apiBaseUrl(): string {
    return `${getPlatformProxyBaseUrl()}/v1/openai`
  }
}
