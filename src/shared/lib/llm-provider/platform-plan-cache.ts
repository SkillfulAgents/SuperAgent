import { background } from '@shared/lib/background'
import { z } from 'zod'
import { expiringMap } from '@shared/lib/host-state/expiring-map'
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

// An expired entry is still served while it reloads, so the store keeps it a day.
const entrySchema = z.object({
  policy: z.object({ planName: z.string().nullable(), deniedModels: z.array(z.string()) }).nullable(),
  expiresAt: z.number(),
})
const entries = expiringMap<Entry>('platform-plan', 24 * 60 * 60_000, entrySchema)

/**
 * Plan policies per platform account: platform host, workspace and member,
 * because seats in one workspace may hold different plans. Fed by every
 * `/v1/account` read, which carries identity and policy together, and by
 * billing reads. Model selection reads it on every turn, so a read never waits
 * on the platform unless the account has no entry yet. Entries live in the
 * shared host state when there is one, so an upgrade seen by one process
 * unlocks models in all of them.
 */
class PlatformPlanCache {
  private loads = new Map<string, Promise<PlatformPlanPolicy | null>>()
  private generation = 0
  /** This process's writes, in order: a read waits for them, as it did when they were synchronous. */
  private writes: Promise<void> = Promise.resolve()

  key(orgId: string | null | undefined, memberId: string | null | undefined): string {
    return JSON.stringify([getPlatformBaseUrl(), orgId ?? null, memberId ?? null])
  }

  /** Record what a platform response said. Saying nothing never replaces an answer. */
  remember(key: string, policy: PlatformPlanPolicy | null): void {
    this.enqueue(() => this.store(key, policy), 'platform-plan-cache.remember-policy')
  }

  private async store(key: string, policy: PlatformPlanPolicy | null): Promise<void> {
    const known = (await entries.get(key))?.policy
    if (!policy && known) {
      await entries.put(key, { policy: known, expiresAt: Date.now() + UNKNOWN_MS })
      return
    }
    await entries.put(key, { policy, expiresAt: Date.now() + (policy ? FRESH_MS : UNKNOWN_MS) })
  }

  private enqueue(write: () => Promise<void>, name: string): void {
    const next = this.writes.then(write)
    this.writes = next.catch(() => undefined)
    background(next, { name })
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
    await this.writes
    const entry = await entries.get(key)
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
      .then(async (policy) => {
        // A load that began before a clear() may carry the policy it cleared.
        if (generation === this.generation) await this.store(key, policy)
        return (await entries.get(key))?.policy ?? policy
      })
      .finally(() => this.loads.delete(key))
    this.loads.set(key, next)
    return next
  }

  /** Forget every account: a refusal proved one stale, or the platform connection changed. */
  clear(): void {
    this.generation += 1
    this.loads.clear()
    this.enqueue(() => entries.clear(), 'platform-plan-cache.clear')
  }
}

export const platformPlanCache = new PlatformPlanCache()
