export const LLM_PROVIDER_IDS = [
  'anthropic',
  'claude-subscription',
  'openrouter',
  'bedrock',
  'platform',
  'generic',
] as const

export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number]
