import Anthropic from '@anthropic-ai/sdk'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { getSettings, type ApiKeyStatus } from '../config/settings'
import { BaseLlmProvider, type ModelOption, type ModelPurpose } from './base-llm-provider'

export class BedrockLlmProvider extends BaseLlmProvider {
  readonly id = 'bedrock' as const
  readonly name = 'AWS Bedrock'
  // Used for simple Bedrock API Key auth (AWS_BEARER_TOKEN_BEDROCK)
  protected readonly settingsKeyField = 'bedrockApiKey' as const
  protected readonly envVarName = 'AWS_BEARER_TOKEN_BEDROCK'

  /** Get the configured AWS region (settings > env > default). */
  private getRegion(): string {
    const settings = getSettings()
    return settings.apiKeys?.bedrockRegion ?? process.env.AWS_REGION ?? 'us-east-1'
  }

  /**
   * Override: Bedrock is configured if EITHER:
   * 1. Bedrock API Key is set (simple auth), OR
   * 2. AWS access key + secret are set (advanced auth)
   */
  getApiKeyStatus(): ApiKeyStatus {
    // Check simple Bedrock API Key first
    const simpleStatus = super.getApiKeyStatus()
    if (simpleStatus.isConfigured) return simpleStatus

    // Check full AWS credentials
    const settings = getSettings()
    if (settings.apiKeys?.bedrockAccessKeyId && settings.apiKeys?.bedrockSecretAccessKey) {
      return { isConfigured: true, source: 'settings' }
    }
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  createClient(): Anthropic {
    const settings = getSettings()
    const region = this.getRegion()

    // Simple auth: Bedrock API Key — temporarily set env var for the AWS credential chain.
    // The Bedrock SDK reads AWS_BEARER_TOKEN_BEDROCK from env (no constructor param for it).
    const bearerToken = this.getEffectiveApiKey()
    if (bearerToken) {
      const prev = process.env.AWS_BEARER_TOKEN_BEDROCK
      process.env.AWS_BEARER_TOKEN_BEDROCK = bearerToken
      const client = new AnthropicBedrock({ awsRegion: region }) as unknown as Anthropic
      // Restore — the credential is captured by the SDK at construction time
      if (prev !== undefined) process.env.AWS_BEARER_TOKEN_BEDROCK = prev
      else delete process.env.AWS_BEARER_TOKEN_BEDROCK
      return client
    }

    // Advanced auth: AWS access key credentials
    const accessKeyId = settings.apiKeys?.bedrockAccessKeyId || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = settings.apiKeys?.bedrockSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY

    if (accessKeyId && secretAccessKey) {
      return new AnthropicBedrock({
        awsRegion: region,
        awsAccessKey: accessKeyId,
        awsSecretKey: secretAccessKey,
      }) as unknown as Anthropic
    }

    // Fallback: default AWS credential chain (e.g. ~/.aws/credentials)
    return new AnthropicBedrock({ awsRegion: region }) as unknown as Anthropic
  }

  getAvailableModels(): ModelOption[] {
    return [
      { value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude 4.5 Haiku' },
      { value: 'us.anthropic.claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
      { value: 'us.anthropic.claude-opus-4-6-v1', label: 'Claude 4.6 Opus' },
      { value: 'us.anthropic.claude-opus-4-7', label: 'Claude 4.7 Opus' },
    ]
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
      case 'agent': return 'us.anthropic.claude-sonnet-4-6'
      case 'browser': return 'us.anthropic.claude-sonnet-4-6'
    }
  }

  getContainerEnvVars(_agentId: string): Record<string, string | undefined> {
    const settings = getSettings()
    const region = this.getRegion()
    const bearerToken = this.getEffectiveApiKey()

    return {
      // Enable Bedrock mode in Claude Code SDK
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: region,
      // Simple auth
      AWS_BEARER_TOKEN_BEDROCK: bearerToken || undefined,
      // Advanced auth (only if no bearer token)
      AWS_ACCESS_KEY_ID: !bearerToken ? (settings.apiKeys?.bedrockAccessKeyId || process.env.AWS_ACCESS_KEY_ID) : undefined,
      AWS_SECRET_ACCESS_KEY: !bearerToken ? (settings.apiKeys?.bedrockSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY) : undefined,
      // Clear Anthropic API key so container uses Bedrock
      ANTHROPIC_API_KEY: undefined,
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const region = this.getRegion()
      // Set bearer token env var for AWS credential chain, then create client
      const prev = process.env.AWS_BEARER_TOKEN_BEDROCK
      process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey
      try {
        const client = new AnthropicBedrock({ awsRegion: region })
        await client.messages.create({
          model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        })
        return { valid: true }
      } finally {
        // Restore previous env var
        if (prev !== undefined) {
          process.env.AWS_BEARER_TOKEN_BEDROCK = prev
        } else {
          delete process.env.AWS_BEARER_TOKEN_BEDROCK
        }
      }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Invalid credentials' }
    }
  }

  /** Validate full AWS credentials (access key + secret). */
  async validateAwsCredentials(accessKeyId: string, secretAccessKey: string, region: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new AnthropicBedrock({
        awsRegion: region,
        awsAccessKey: accessKeyId,
        awsSecretKey: secretAccessKey,
      })
      await client.messages.create({
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Invalid credentials' }
    }
  }
}
