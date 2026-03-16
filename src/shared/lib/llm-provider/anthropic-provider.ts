import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelOption, type ModelPurpose } from './base-llm-provider'

export class AnthropicLlmProvider extends BaseLlmProvider {
  readonly id = 'anthropic' as const
  readonly name = 'Anthropic (Claude)'
  protected readonly settingsKeyField = 'anthropicApiKey' as const
  protected readonly envVarName = 'ANTHROPIC_API_KEY'

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Anthropic API key not configured')
    return new Anthropic({ apiKey })
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
