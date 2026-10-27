import Anthropic from '@anthropic-ai/sdk'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { BaseLlmProvider } from './base-llm-provider'
import { translatedMessagesFetch } from './translated-messages-fetch'
import { extractErrorMessage, inferErrorStatus } from './error-presentation'

/** A subscription sold as a dedicated plan key. The key only works on the plan's own endpoint. */
export abstract class PlanKeyLlmProvider extends BaseLlmProvider {
  protected abstract readonly planName: string
  protected abstract readonly baseUrl: string
  protected abstract readonly format: 'messages' | 'responses'
  protected readonly settingsKeyField = 'planApiKey' as const
  protected readonly envVarName = ''
  readonly defaultModelOptions = []

  // The OpenAI translation rebuilds every tool, so `defer_loading` never reaches the endpoint.
  override toolSearchEnv() { return this.format === 'messages' ? 'false' as const : 'true' as const }

  private requireKey(): string {
    const key = this.getEffectiveApiKey()
    if (!key) throw new Error(`${this.planName} key not configured`)
    return key
  }
  private client(apiKey: string): Anthropic {
    return new Anthropic({ baseURL: this.baseUrl, authToken: apiKey,
      ...(this.format !== 'messages' ? { fetch: translatedMessagesFetch(this.baseUrl, apiKey, this.format) } : {}) })
  }
  createClient(): Anthropic { return this.client(this.requireKey()) }

  async getContainerEnvVars(): Promise<Record<string, string | undefined>> {
    if (this.format !== 'messages') return {}
    return { ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: this.baseUrl, ANTHROPIC_AUTH_TOKEN: this.getEffectiveApiKey() }
  }
  override async getContainerProxyConfig(): Promise<LlmProxyConfig | undefined> {
    if (this.format === 'messages') return undefined
    return { format: this.format, baseUrl: this.baseUrl, credential: { accessToken: this.requireKey(), generation: 0 }, headers: {} }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const key = apiKey || this.getEffectiveApiKey()
    if (!key) return { valid: false, error: `Enter your ${this.planName} key` }
    const model = this.getBuiltinCatalog().find(entry => entry.isDefault)?.id
    if (!model) return { valid: false, error: `${this.planName} has no default model` }
    try {
      await this.client(key).messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : `Invalid ${this.planName} key` }
    }
  }

  protected override parseErrorResponseOverride(status: number | undefined, body: unknown) {
    const message = extractErrorMessage(body)
    const actual = status ?? inferErrorStatus(message)
    if (actual === 401) return { severity: 'error' as const, icon: 'info' as const, message: `**${this.planName} key was rejected.** Check the key in Settings → Model Providers.` }
    if (actual === 402 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: `**${this.planName} denied this request.** ${message}` }
    return null
  }
}
