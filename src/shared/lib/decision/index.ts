import { getSettings } from '../config/settings'
import { BaseDecisionProvider } from './decision-provider'
import { CloudflareDecisionProvider } from './cloudflare-provider'
import { OpenaiDecisionProvider } from './openai-provider'
import { PlatformDecisionProvider } from './platform-provider'
import { TypesafeDecisionProvider } from './typesafe-provider'
import { DEFAULT_DECISION_PROVIDER, type DecisionProviderId, type DecisionRequest, type DecisionResult } from './types'

export { DECISION_PROVIDERS, DEFAULT_DECISION_PROVIDER } from './types'
export type { DecisionAnswer, DecisionProviderId, DecisionQuestion, DecisionRequest, DecisionResult, DecisionSettings } from './types'

const providers = {
  platform: new PlatformDecisionProvider(),
  openai: new OpenaiDecisionProvider(),
  typesafe: new TypesafeDecisionProvider(),
  cloudflare: new CloudflareDecisionProvider(),
} satisfies Record<DecisionProviderId, BaseDecisionProvider>

export function getDecisionProvider(id: DecisionProviderId): BaseDecisionProvider {
  return providers[id]
}

/** The selected decision provider when it has a key, else null so callers use their own fallback. */
export function getConfiguredDecisionProvider(): BaseDecisionProvider | null {
  const provider = providers[getSettings().decision?.provider ?? DEFAULT_DECISION_PROVIDER]
  return provider.getApiKeyStatus().isConfigured ? provider : null
}

/** Ask the selected decision model. Throws when none is configured. */
export async function decide(request: DecisionRequest): Promise<DecisionResult> {
  const provider = getConfiguredDecisionProvider()
  if (!provider) throw new Error('No decision model configured.')
  return provider.decide(request)
}
