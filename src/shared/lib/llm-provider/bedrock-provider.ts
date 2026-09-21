import Anthropic from '@anthropic-ai/sdk'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { type ApiKeyStatus } from '../config/settings'
import { BaseLlmProvider } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { BEDROCK_CATALOG, CLAUDE_DEFAULT_MODEL_OPTIONS } from './builtin-catalogs'
import { BEDROCK_CATALOG_DEFAULT_MODELS } from './model-catalog-defaults'

export class BedrockLlmProvider extends BaseLlmProvider {
  readonly id = 'bedrock' as const
  readonly name = 'AWS Bedrock'
  readonly defaultModelOptions = CLAUDE_DEFAULT_MODEL_OPTIONS
  readonly catalogDefaultModels = BEDROCK_CATALOG_DEFAULT_MODELS
  // Used for simple Bedrock API Key auth (AWS_BEARER_TOKEN_BEDROCK)
  // Bedrock serves Claude models, and the CLI's own guard (which only fires
  // for custom first-party base URLs) never applies in Bedrock mode.
  override readonly toolSearchEnv = 'true' as const
  protected readonly settingsKeyField = 'bedrockApiKey' as const
  protected readonly envVarName = 'AWS_BEARER_TOKEN_BEDROCK'

  /** Get the configured AWS region (settings > env > default). */
  private getRegion(): string {
    const settings = { apiKeys: this.configuredKeys() }
    return settings.apiKeys?.bedrockRegion ?? this.envValue('AWS_REGION') ?? 'us-east-1'
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
    const settings = { apiKeys: this.configuredKeys() }
    if (settings.apiKeys?.bedrockAccessKeyId && settings.apiKeys?.bedrockSecretAccessKey) {
      return { isConfigured: true, source: 'settings' }
    }
    if (this.envValue('AWS_ACCESS_KEY_ID') && this.envValue('AWS_SECRET_ACCESS_KEY')) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  createClient(): Anthropic {
    const settings = { apiKeys: this.configuredKeys() }
    const region = this.getRegion()

    // Pass bearer credentials directly; different connections can run concurrently.
    const bearerToken = this.getEffectiveApiKey()
    if (bearerToken) {
      return new AnthropicBedrock({ awsRegion: region, apiKey: bearerToken }) as unknown as Anthropic
    }

    // Advanced auth: AWS access key credentials
    const accessKeyId = settings.apiKeys?.bedrockAccessKeyId || this.envValue('AWS_ACCESS_KEY_ID')
    const secretAccessKey = settings.apiKeys?.bedrockSecretAccessKey || this.envValue('AWS_SECRET_ACCESS_KEY')

    if (accessKeyId && secretAccessKey) {
      return new AnthropicBedrock({
        awsRegion: region,
        apiKey: '',
        awsAccessKey: accessKeyId,
        awsSecretKey: secretAccessKey,
      }) as unknown as Anthropic
    }

    // Fallback: default AWS credential chain (e.g. ~/.aws/credentials)
    return new AnthropicBedrock({ awsRegion: region }) as unknown as Anthropic
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return BEDROCK_CATALOG
  }

  async getContainerEnvVars(): Promise<Record<string, string | undefined>> {
    const settings = { apiKeys: this.configuredKeys() }
    const region = this.getRegion()
    const bearerToken = this.getEffectiveApiKey()

    return {
      // Enable Bedrock mode in Claude Code SDK
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: region,
      // Simple auth
      AWS_BEARER_TOKEN_BEDROCK: bearerToken || undefined,
      // Advanced auth (only if no bearer token)
      AWS_ACCESS_KEY_ID: !bearerToken ? (settings.apiKeys?.bedrockAccessKeyId || this.envValue('AWS_ACCESS_KEY_ID')) : undefined,
      AWS_SECRET_ACCESS_KEY: !bearerToken ? (settings.apiKeys?.bedrockSecretAccessKey || this.envValue('AWS_SECRET_ACCESS_KEY')) : undefined,
      // Clear Anthropic API key so container uses Bedrock
      ANTHROPIC_API_KEY: undefined,
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const region = this.getRegion()
      const client = new AnthropicBedrock({ awsRegion: region, apiKey })
      await client.messages.create({
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Invalid credentials' }
    }
  }

  /** Validate full AWS credentials (access key + secret). */
  async validateAwsCredentials(accessKeyId: string, secretAccessKey: string, region: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new AnthropicBedrock({
        awsRegion: region,
        apiKey: '',
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
