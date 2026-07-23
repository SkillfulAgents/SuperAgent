import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type AgentIdentity, type ModelPurpose } from './base-llm-provider'
import { rewriteLoopbackForContainer } from './container-url'
import type { ModelDefinition } from './model-catalog-schema'
import { PLATFORM_CATALOG } from './builtin-catalogs'
import { attribution } from '@shared/lib/platform-attribution'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import type { ApiKeyStatus } from '../config/settings'

// Display names are user-controlled free text headed for an HTTP header via
// an env file: collapse control chars (the env-file writer drops \r\n outright,
// silently corrupting multi-word values otherwise) and cap by code point so a
// later slice can't split a surrogate pair.
export function sanitizeAgentName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const flattened = name.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return Array.from(flattened).slice(0, 200).join('')
}

export class PlatformLlmProvider extends BaseLlmProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'
  // Not used — getApiKeyStatus/getEffectiveApiKey are both overridden to
  // read the platform token instead of a settings-stored API key.
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
    return getPlatformAccessToken() ?? process.env[this.envVarName] ?? undefined
  }

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Platform token not configured. Please log in to the platform.')
    return new Anthropic({
      apiKey: '',
      baseURL: getPlatformProxyBaseUrl(),
      authToken: apiKey,
    })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return PLATFORM_CATALOG
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'haiku'
      case 'agent': return 'opus'
      case 'browser': return 'sonnet'
      case 'dashboard': return 'opus'
    }
  }

  getContainerEnvVars(
    agent?: AgentIdentity,
    hostAddress?: string,
  ): Record<string, string | undefined> {
    const proxyUrl = getPlatformProxyBaseUrl()
    const containerUrl = rewriteLoopbackForContainer(proxyUrl, hostAddress)

    const auth = attribution.current()
    const authToken = auth?.bearerToken() ?? this.getEffectiveApiKey()

    // Agent identity rides into the container as plain env vars; the container
    // folds them into ANTHROPIC_CUSTOM_HEADERS itself (see agent-container/src/
    // attribution-headers.ts) because the env file transport strips newlines,
    // which the multi-header ANTHROPIC_CUSTOM_HEADERS format needs.
    const agentName = agent?.name && sanitizeAgentName(agent.name)

    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: containerUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
      ...(agent && {
        SUPERAGENT_AGENT_ID: agent.id,
        ...(agentName && { SUPERAGENT_AGENT_NAME: agentName }),
      }),
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({
        apiKey: '',
        baseURL: getPlatformProxyBaseUrl(),
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
