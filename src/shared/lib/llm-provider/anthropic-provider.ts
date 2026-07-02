import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelPurpose } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { CLAUDE_BARE_CATALOG } from './builtin-catalogs'

export class AnthropicLlmProvider extends BaseLlmProvider {
  readonly id = 'anthropic' as const
  readonly name = 'Anthropic'
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

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'haiku'
      case 'agent': return 'opus'
      case 'browser': return 'sonnet'
      case 'dashboard': return 'opus'
    }
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
