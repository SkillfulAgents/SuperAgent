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

// Members may configure their provider and model, but must not acquire control
// over the subprocess loader, TLS/proxy settings, credential files or CLI config
// directory. Keep this explicit: new ANTHROPIC_* / CLAUDE_CODE_* variables can
// change execution behavior and need review before members may set them.
const MEMBER_PROVIDER_ENV_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'ENABLE_TOOL_SEARCH',
])

export function findAdminOnlyProviderEnvVars(vars: Record<string, string>): string[] {
  return Object.keys(vars).filter(key => !MEMBER_PROVIDER_ENV_KEYS.has(key))
}
