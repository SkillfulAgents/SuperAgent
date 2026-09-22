import type { LlmProviderId } from './provider-types'

/** Provider credentials and CLI overrides are scoped to one LLM connection.
 * General AWS variables also remain available globally for agent tools. */
export function isProviderEnvVar(key: string, provider?: LlmProviderId): boolean {
  return /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX)$|AWS_BEARER_TOKEN_BEDROCK$)/.test(key)
    || (provider === 'bedrock' && /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION)$/.test(key))
}

export function providerEnvVarsError(vars: Record<string, unknown>): string | undefined {
  const keys = Object.keys(vars).filter(key => isProviderEnvVar(key))
  return keys.length
    ? `Set LLM provider variables in Settings → LLM → Edit connection → Custom environment variables: ${keys.join(', ')}`
    : undefined
}
