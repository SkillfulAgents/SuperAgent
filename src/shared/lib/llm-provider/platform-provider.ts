import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelOption, type ModelPurpose } from './base-llm-provider'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { attribution } from '@shared/lib/attribution'
import type { ApiKeyStatus } from '../config/settings'

export class PlatformLlmProvider extends BaseLlmProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'PLATFORM_TOKEN'

  override getApiKeyStatus(): ApiKeyStatus {
    const token = getPlatformAccessToken()
    if (token) {
      return { isConfigured: true, source: 'settings' }
    }
    if (process.env[this.envVarName]) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? undefined
  }

  private createPlatformClient(token: string): Anthropic {
    return new Anthropic({
      apiKey: '',
      baseURL: getPlatformProxyBaseUrl(),
      authToken: token,
    })
  }

  createClient(): Anthropic {
    const token = this.getEffectiveApiKey()
    if (!token) throw new Error('Platform token not configured. Please log in to the platform.')
    return this.createPlatformClient(token)
  }

  getAvailableModels(): ModelOption[] {
    return [
      { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
      { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
      { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
      { value: 'claude-opus-4-7', label: 'Claude 4.7 Opus' },
    ]
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'claude-haiku-4-5'
      case 'agent': return 'claude-opus-4-7'
      case 'browser': return 'claude-sonnet-4-6'
    }
  }

  getContainerEnvVars(agentId: string): Record<string, string | undefined> {
    const proxyUrl = getPlatformProxyBaseUrl()
    const containerUrl = proxyUrl.replace('://localhost', '://host.docker.internal')
    const token = this.getEffectiveApiKey()

    // ANTHROPIC_CUSTOM_HEADERS must be newline-delimited "Name: value"
    // lines (not JSON) for claude-agent-sdk to parse them as headers.
    const auth = attribution.fromAgentOwner(agentId)
    const customHeaders = auth
      ?.toExtraHeaderEntries()
      .map(([name, value]) => `${name}: ${value}`)
      .join('\n')

    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: containerUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders || undefined,
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = this.createPlatformClient(apiKey)
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Platform token validation failed' }
    }
  }
}
