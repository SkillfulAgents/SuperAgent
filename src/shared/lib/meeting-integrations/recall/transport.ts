import { attribution } from '../../platform-attribution'
import { getPlatformAccessToken } from '../../services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '../../platform-auth/config'
import { IntegrationPolicyError } from '../../agent-integrations/errors'

/**
 * How this host reaches Recall.ai. The platform proxy is the product path:
 * it holds the vendor key, scopes bots to the organization and bills bot
 * time. A self-hosted deployment may instead set `RECALL_API_KEY` (and
 * `RECALL_REGION`) and talk to Recall directly with its own account.
 */
export interface RecallTransport {
  /** Base of Recall's v1 API as this host sees it, without trailing slash. */
  readonly baseUrl: string
  /** The Authorization header for one call, attributed to the person who owns the work. */
  authorization(ownerUserId: string | null): Promise<string>
  readonly kind: 'platform' | 'direct'
}

export const RECALL_REGIONS = ['us-west-2', 'us-east-1', 'eu-central-1', 'ap-northeast-1'] as const

export function resolveRecallTransport(): RecallTransport | null {
  const apiKey = process.env.RECALL_API_KEY?.trim()
  if (apiKey) {
    const region = (RECALL_REGIONS as readonly string[]).includes(process.env.RECALL_REGION?.trim() ?? '') ? process.env.RECALL_REGION!.trim() : 'us-west-2'
    return { kind: 'direct', baseUrl: `https://${region}.recall.ai/api/v1`, authorization: async () => `Token ${apiKey}` }
  }
  const proxy = getPlatformProxyBaseUrl()
  if (!proxy || !getPlatformAccessToken()) return null
  return {
    kind: 'platform',
    baseUrl: `${proxy}/v1/recall`,
    async authorization(ownerUserId) {
      const auth = ownerUserId ? await attribution.fromUserId(ownerUserId) : await attribution.current()
      if (auth) return `Bearer ${auth.bearerToken()}`
      // Single-user installations have no user row or ambient request while polling.
      if (!attribution.requiresActingMember()) return `Bearer ${getPlatformAccessToken()!}`
      throw new IntegrationPolicyError('A Platform member identity is required to run meeting bots.')
    },
  }
}
