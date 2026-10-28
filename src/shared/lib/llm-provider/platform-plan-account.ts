import { attribution } from '@shared/lib/platform-attribution'
import {
  fetchActingPlatformAccount,
  getPlatformAuthStatus,
  getStoredPlatformMemberId,
} from '@shared/lib/services/platform-auth-service'

import { platformPlanCache, type PlatformPlanPolicy } from './platform-plan-cache'
import { accountPlanPolicy } from './platform-plan-policy'

/**
 * Cache key for the account the current request or run is attributed to: the
 * same member the fetch interceptor puts on its platform calls (an org token's
 * acting member), else the connected account's own member.
 */
export async function actingPlanCacheKey(): Promise<string> {
  const acting = await attribution.current()
  return platformPlanCache.key(getPlatformAuthStatus().orgId, acting?.actingMemberId() ?? getStoredPlatformMemberId())
}

/** The acting account's plan policy: cached, else read with its identity from `/v1/account`. */
export async function actingPlanPolicy(options: { fresh?: boolean } = {}): Promise<PlatformPlanPolicy | null> {
  return platformPlanCache.get(
    await actingPlanCacheKey(),
    async () => accountPlanPolicy(await fetchActingPlatformAccount()),
    options,
  )
}
