export const LLM_PROVIDER_IDS = [
  'anthropic',
  'claude-subscription',
  'grok-subscription',
  'codex-subscription',
  'kimi-subscription',
  'openrouter',
  'bedrock',
  'platform',
  'generic',
] as const

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]

/** Subscriptions connected by device sign-in; the app owns their token refresh. */
export const OAUTH_PROVIDER_IDS = ['grok-subscription', 'codex-subscription', 'kimi-subscription'] as const
export type OAuthProvider = (typeof OAUTH_PROVIDER_IDS)[number]
export function isOAuthProvider(id: string): id is OAuthProvider {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(id)
}
