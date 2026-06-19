import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelPurpose } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { OPENROUTER_CATALOG } from './builtin-catalogs'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'

export class OpenRouterLlmProvider extends BaseLlmProvider {
  readonly id = 'openrouter' as const
  readonly name = 'OpenRouter'
  protected readonly settingsKeyField = 'openrouterApiKey' as const
  protected readonly envVarName = 'OPENROUTER_API_KEY'

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('OpenRouter API key not configured')
    // OpenRouter uses the Anthropic-compatible API with Bearer auth.
    // apiKey must be empty string so the SDK doesn't send x-api-key header;
    // authToken sends the OpenRouter key via the Authorization: Bearer header.
    return new Anthropic({
      apiKey: '',
      baseURL: OPENROUTER_BASE_URL,
      authToken: apiKey,
    })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return OPENROUTER_CATALOG
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'haiku'
      case 'agent': return 'sonnet'
      case 'browser': return 'sonnet'
      case 'dashboard': return 'opus'
    }
  }

  getContainerEnvVars(): Record<string, string | undefined> {
    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: this.getEffectiveApiKey(),
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({
        apiKey: '',
        baseURL: OPENROUTER_BASE_URL,
        authToken: apiKey,
      })
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
