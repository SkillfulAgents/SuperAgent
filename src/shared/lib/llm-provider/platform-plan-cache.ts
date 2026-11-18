import { appState, defineNamespace, digestKeyPart } from '@shared/lib/app-state'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'

import { cachedPlanPolicySchema, type PlatformPlanPolicy } from './platform-plan-cache-schema'

export type { PlatformPlanPolicy }

// A plan's model list changes when the plan does, which is rare. A change is
// seen within this long, and at once after a billing read (the Account screen)
// or a fresh read (the picker after an upgrade, the refusal card).
const KEPT_MS = 60 * 60_000
// No answer (an older proxy, or the account could not be read): ask again sooner.
const UNKNOWN_MS = 10 * 60_000

// In AppState, so a process that starts often selects a model without reading
// the account again (SUP-1634). A plain cache: the last write wins.
const planPolicies = defineNamespace({
  name: 'cache:platform-plan-policy',
  consistency: 'eventual',
  schema: cachedPlanPolicySchema,
  expiry: { ttlMs: KEPT_MS, onUpdate: 'reset' },
})

/**
 * Plan policies per platform account: platform host, workspace and member,
 * because seats in one workspace may hold different plans. Fed by every
 * `/v1/account` read, which carries identity and policy together, and by
 * billing reads. Model selection reads it on every turn, so a read waits on
 * the network only when the account has no entry. AppState failing never
 * fails a read or a write here: the account is read instead.
 */
class PlatformPlanCache {
  // Loads under way in this process, so its concurrent readers share one.
  private loads = new Map<string, Promise<PlatformPlanPolicy | null>>()

  key(orgId: string | null | undefined, memberId: string | null | undefined): string {
    return JSON.stringify([getPlatformBaseUrl(), orgId ?? null, memberId ?? null])
  }

  /** Record what a platform response said. One that says nothing records nothing. */
  async remember(key: string, policy: PlatformPlanPolicy | null): Promise<void> {
    if (policy) await this.store(key, policy)
  }

  /**
   * The account's policy: the cached one, else `load`'s. `fresh` skips the
   * cache. Null when nothing is known, which callers read as no restriction,
   * like the proxy.
   */
  async get(
    key: string,
    load: () => Promise<PlatformPlanPolicy | null>,
    options: { fresh?: boolean } = {},
  ): Promise<PlatformPlanPolicy | null> {
    if (!options.fresh) {
      const cached = await this.stored(key)
      if (cached) return cached.policy
    }
    return this.load(key, load)
  }

  private load(key: string, load: () => Promise<PlatformPlanPolicy | null>): Promise<PlatformPlanPolicy | null> {
    const pending = this.loads.get(key)
    if (pending) return pending
    const next = load()
      .catch(() => null)
      .then(async (policy) => {
        if (policy) {
          await this.store(key, policy)
          return policy
        }
        // Saying nothing never replaces an answer.
        const cached = await this.stored(key)
        if (cached) return cached.policy
        await this.store(key, null)
        return null
      })
      .finally(() => this.loads.delete(key))
    this.loads.set(key, next)
    return next
  }

  private async stored(key: string): Promise<{ policy: PlatformPlanPolicy | null } | null> {
    try {
      return (await appState().get(storedKey(key)))?.value ?? null
    } catch (error) {
      console.error('[PlatformPlanCache] Reading a cached policy failed:', error)
      return null
    }
  }

  private async store(key: string, policy: PlatformPlanPolicy | null): Promise<void> {
    try {
      await appState().set(storedKey(key), { policy }, policy ? {} : { expiry: { ttlMs: UNKNOWN_MS } })
    } catch (error) {
      console.error('[PlatformPlanCache] Caching a policy failed:', error)
    }
  }
}

// The cache key names the platform host and account ids, which stay out of an AppState key.
function storedKey(key: string) {
  return planPolicies.key(digestKeyPart(key))
}

export const platformPlanCache = new PlatformPlanCache()
