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
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'ANTHROPIC_API_KEY'

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Anthropic API key not configured')
    return new Anthropic({ apiKey })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return CLAUDE_BARE_CATALOG
  }

  getContainerEnvVars(): Record<string, string | undefined> {
    return {
      ANTHROPIC_API_KEY: this.getEffectiveApiKey(),
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
