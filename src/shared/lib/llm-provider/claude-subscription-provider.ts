import type Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider } from './base-llm-provider'
import { CLAUDE_BARE_CATALOG, CLAUDE_DEFAULT_MODEL_OPTIONS } from './builtin-catalogs'
import { ANTHROPIC_CATALOG_DEFAULT_MODELS } from './model-catalog-defaults'
import { extractErrorMessage, type ProviderErrorPresentation } from './error-presentation'

export const CLAUDE_SUBSCRIPTION_RECONNECT = 'Run `claude setup-token` again, then replace the token in Settings → Model Providers.'

/** Subscription credentials are consumed by Claude Code, never a direct SDK client. */
export class ClaudeSubscriptionLlmProvider extends BaseLlmProvider {
  readonly id = 'claude-subscription' as const
  readonly name = 'Claude Subscription'
  readonly defaultModelOptions = CLAUDE_DEFAULT_MODEL_OPTIONS
  readonly catalogDefaultModels = ANTHROPIC_CATALOG_DEFAULT_MODELS
  protected readonly settingsKeyField = 'claudeSubscriptionToken' as const
  protected readonly envVarName = 'CLAUDE_CODE_OAUTH_TOKEN'
  override readonly toolSearchEnv = 'true' as const
  override readonly supportsDirectApi = false

  // Optional connections never adopt ambient host or legacy settings credentials.
  override getEffectiveApiKey(): string | undefined {
    return this.configuration?.apiKeys.claudeSubscriptionToken
  }

  override getApiKeyStatus() {
    return this.getEffectiveApiKey()
      ? { isConfigured: true, source: 'settings' as const }
      : { isConfigured: false, source: 'none' as const }
  }

  createClient(): Anthropic {
    throw new Error('Claude Subscription supports agent sessions only. Choose an API-capable global summarizer in Settings → Model Providers.')
  }

  getBuiltinCatalog() { return CLAUDE_BARE_CATALOG }

  async getContainerEnvVars(): Promise<Record<string, string | undefined>> {
    return { CLAUDE_CODE_OAUTH_TOKEN: this.getEffectiveApiKey() }
  }

  async validateKey(): Promise<{ valid: boolean; error?: string }> {
    // Neither /models nor a token-shaped string proves subscription inference.
    return { valid: false, error: 'Claude Subscription authentication is checked when you send an agent message. Save the token and start a session to verify it.' }
  }

  protected override parseErrorResponseOverride(status: number | undefined, body: unknown): ProviderErrorPresentation | null {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : body
    const authenticationError = error && typeof error === 'object' && 'type' in error && error.type === 'authentication_error'
    const expiredToken = /\btoken\s+(?:(?:has been|has|is|was)\s+)?(?:expired|revoked)\b|\b(?:expired|revoked)\s+(?:(?:oauth|access|refresh)\s+)?token\b|\bauthentication_error\b/i.test(extractErrorMessage(body))
    if (status === 401 || authenticationError || expiredToken) {
      return { severity: 'error', icon: 'info', message: `**Claude Subscription sign-in expired or invalid.** ${CLAUDE_SUBSCRIPTION_RECONNECT}` }
    }
    return null
  }
}
