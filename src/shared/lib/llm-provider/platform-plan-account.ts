import { attribution, type Attribution } from '@shared/lib/platform-attribution'
import {
  fetchActingPlatformAccount,
  platformAuthStatusFrom,
  storedPlatformMemberIdFrom,
} from '@shared/lib/services/platform-auth-service'
import { getSettings, type AppSettings } from '@shared/lib/config/settings'

import { platformPlanCache, type PlatformPlanPolicy } from './platform-plan-cache'
import { accountPlanPolicy } from './platform-plan-policy'

/** What an operation already read, so a chain of availability checks reads it once. */
export interface ActingPlanContext {
  /** The global settings the operation read; read here when absent. */
  settings?: Pick<AppSettings, 'platformAuth'>
  /** The operation's attribution, resolved at most once ({@link actingAttributionOnce}). */
  acting?: () => Promise<Attribution | null>
}

/**
 * The attribution the current request or run acts under, resolved on first
 * use and then shared by the rest of one operation (one selection, one
 * listing). Never keep it past that operation: the next one resolves again.
 */
export function actingAttributionOnce(): () => Promise<Attribution | null> {
  let resolved: Promise<Attribution | null> | undefined
  // The promise is kept from the first call, so concurrent checks share it.
  return () => (resolved ??= Promise.resolve(attribution.current()))
}

/**
 * Cache key for the account the current request or run is attributed to: the
 * same member the fetch interceptor puts on its platform calls (an org token's
 * acting member), else the connected account's own member.
 */
export async function actingPlanCacheKey(context: ActingPlanContext = {}): Promise<string> {
  const settings = context.settings ?? await getSettings()
  const acting = context.acting ? await context.acting() : await attribution.current()
  // A corrupt stored record is reported once, by the status read.
  const orgId = platformAuthStatusFrom(settings).orgId
  return platformPlanCache.key(orgId, acting?.actingMemberId() ?? storedPlatformMemberIdFrom(settings, { report: false }))
}

/** The acting account's plan policy: cached, else read with its identity from `/v1/account`. */
export async function actingPlanPolicy(options: { fresh?: boolean } & ActingPlanContext = {}): Promise<PlatformPlanPolicy | null> {
  return platformPlanCache.get(
    await actingPlanCacheKey(options),
    async () => accountPlanPolicy(await fetchActingPlatformAccount()),
    { fresh: options.fresh },
  )
}
