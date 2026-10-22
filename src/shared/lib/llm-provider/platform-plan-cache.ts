import { background } from '@shared/lib/background'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'

/** What one platform account may not run, and the plan that says so (SUP-1124). */
export interface PlatformPlanPolicy {
  planName: string | null
  /** Canonical model-id prefixes the proxy refuses for this account. */
  deniedModels: string[]
}

// A plan's model list changes when the plan does, which is rare; a refusal
// (403) or a read after an upgrade replaces it sooner, so it is kept long.
const FRESH_MS = 60 * 60_000
// No answer (an older proxy, or billing was unreachable): ask again sooner.
const UNKNOWN_MS = 10 * 60_000

type Entry = { policy: PlatformPlanPolicy | null; expiresAt: number }

/**
 * Plan policies per platform account: platform host, workspace and member,
 * because seats in one workspace may hold different plans. Fed by every
 * `/v1/account` read, which carries identity and policy together, and by
 * billing reads. Model selection reads it on every turn, so a read never waits
 * on the network unless the account has no entry yet.
 */
class PlatformPlanCache {
  private entries = new Map<string, Entry>()
  private loads = new Map<string, Promise<PlatformPlanPolicy | null>>()
  private generation = 0

  key(orgId: string | null | undefined, memberId: string | null | undefined): string {
    return JSON.stringify([getPlatformBaseUrl(), orgId ?? null, memberId ?? null])
  }

  /** Record what a platform response said. Saying nothing never replaces an answer. */
  remember(key: string, policy: PlatformPlanPolicy | null): void {
    const known = this.entries.get(key)?.policy
    if (!policy && known) {
      this.entries.set(key, { policy: known, expiresAt: Date.now() + UNKNOWN_MS })
      return
    }
    this.entries.set(key, { policy, expiresAt: Date.now() + (policy ? FRESH_MS : UNKNOWN_MS) })
  }

  /**
   * The account's policy. A cached one is served at once, reloading in the
   * background once expired; a miss, or `fresh`, waits for `load`. Null when
   * nothing is known, which callers read as no restriction, like the proxy.
   */
  async get(
    key: string,
    load: () => Promise<PlatformPlanPolicy | null>,
    options: { fresh?: boolean } = {},
  ): Promise<PlatformPlanPolicy | null> {
    const entry = this.entries.get(key)
    if (entry && !options.fresh) {
      if (entry.expiresAt <= Date.now()) background(this.reload(key, load), { name: 'platform-plan-cache.reload-policy' })
      return entry.policy
    }
    return this.reload(key, load)
  }

  private reload(key: string, load: () => Promise<PlatformPlanPolicy | null>): Promise<PlatformPlanPolicy | null> {
    const pending = this.loads.get(key)
    if (pending) return pending
    const generation = this.generation
    const next = load()
      .catch(() => null)
      .then((policy) => {
        // A load that began before a clear() may carry the policy it cleared.
        if (generation === this.generation) this.remember(key, policy)
        return this.entries.get(key)?.policy ?? policy
      })
      .finally(() => this.loads.delete(key))
    this.loads.set(key, next)
    return next
  }

  /** Forget every account: a refusal proved one stale, or the platform connection changed. */
  clear(): void {
    this.generation += 1
    this.entries.clear()
    this.loads.clear()
  }
}

export const platformPlanCache = new PlatformPlanCache()
