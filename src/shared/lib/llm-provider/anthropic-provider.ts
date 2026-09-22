import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { CLAUDE_BARE_CATALOG, CLAUDE_DEFAULT_MODEL_OPTIONS } from './builtin-catalogs'
import { ANTHROPIC_CATALOG_DEFAULT_MODELS } from './model-catalog-defaults'

export class AnthropicLlmProvider extends BaseLlmProvider {
  readonly id = 'anthropic' as const
  readonly name = 'Anthropic'
  readonly defaultModelOptions = CLAUDE_DEFAULT_MODEL_OPTIONS
  readonly catalogDefaultModels = ANTHROPIC_CATALOG_DEFAULT_MODELS
  // Anthropic's own API is where deferred tool loading is expanded server-side.
  override readonly toolSearchEnv = 'true' as const
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'ANTHROPIC_API_KEY'

  createClient(): Anthropic {
    const apiKey = this.configuration?.runtimeEnv?.ANTHROPIC_API_KEY ?? this.getEffectiveApiKey()
    const authToken = this.envValue('ANTHROPIC_AUTH_TOKEN') || null
    if (!apiKey && !authToken) throw new Error('Anthropic API key not configured')
    return new Anthropic({
      apiKey: apiKey ?? null,
      baseURL: this.envValue('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
      authToken,
    })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return CLAUDE_BARE_CATALOG
  }

  async getContainerEnvVars(): Promise<Record<string, string | undefined>> {
    return {
      ANTHROPIC_API_KEY: this.getEffectiveApiKey(),
      ANTHROPIC_BASE_URL: this.envValue('ANTHROPIC_BASE_URL'),
      ANTHROPIC_AUTH_TOKEN: this.envValue('ANTHROPIC_AUTH_TOKEN'),
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({ apiKey })
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Invalid API key' }
    }
  }
}
