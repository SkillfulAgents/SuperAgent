import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelOption, type ModelPurpose } from './base-llm-provider'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import type { ApiKeyStatus } from '../config/settings'

const DEFAULT_PROXY_BASE_URL = process.env.DATAWIZZ_PROXY_URL || 'https://platform-proxy-staging.datawizz.workers.dev'

function normalizeProxyBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

function getProxyBaseUrl(): string {
  return normalizeProxyBaseUrl(process.env.DATAWIZZ_PROXY_URL || DEFAULT_PROXY_BASE_URL)
}

function getContainerProxyBaseUrl(): string {
  const raw = getProxyBaseUrl()

  try {
    const url = new URL(raw)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
      url.hostname = 'host.docker.internal'
    }
    return url.toString().replace(/\/+$/, '')
  } catch {
    return raw
  }
}

export class DatawizzLlmProvider extends BaseLlmProvider {
  readonly id = 'datawizz' as const
  readonly name = 'Datawizz Platform'
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'DATAWIZZ_PLATFORM_TOKEN'

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
    return getPlatformAccessToken() ?? process.env[this.envVarName] ?? undefined
  }

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Datawizz platform token not configured. Please log in to the platform.')
    return new Anthropic({
      apiKey: '',
      baseURL: getProxyBaseUrl(),
      authToken: apiKey,
    })
  }

  getAvailableModels(): ModelOption[] {
    return [
      { value: 'claude-haiku-4-5', label: 'Claude 4.5 Haiku' },
      { value: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
      { value: 'claude-opus-4-6', label: 'Claude 4.6 Opus' },
    ]
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'claude-haiku-4-5'
      case 'agent': return 'claude-opus-4-6'
      case 'browser': return 'claude-sonnet-4-6'
    }
  }

  getContainerEnvVars(): Record<string, string | undefined> {
    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: getContainerProxyBaseUrl(),
      ANTHROPIC_AUTH_TOKEN: this.getEffectiveApiKey(),
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({
        apiKey: '',
        baseURL: getProxyBaseUrl(),
        authToken: apiKey,
      })
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
