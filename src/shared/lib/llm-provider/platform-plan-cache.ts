import { z } from 'zod'
import { appState, defineNamespace, digestKeyPart } from '@shared/lib/app-state'
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
// A policy past its fresh time is served while it reloads, for at most this long.
const KEPT_MS = 24 * 60 * 60_000

const storedPolicySchema = z.object({
  policy: z.object({ planName: z.string().nullable(), deniedModels: z.array(z.string()) }).nullable(),
  /** Epoch ms from which a read reloads the policy in the background. */
  staleAt: z.number(),
  /** The generation it was filed under; `clear()` starts a new one. */
  generation: z.number(),
})
type StoredPolicy = z.infer<typeof storedPolicySchema>

// In AppState, so a process that starts often selects a model without reading
// the account again (SUP-1634).
const planPolicies = defineNamespace({
  name: 'cache:platform-plan-policy',
  consistency: 'eventual',
  schema: storedPolicySchema,
  expiry: { ttlMs: KEPT_MS, onUpdate: 'reset' },
})

// AppState deletes one key at a time, so forgetting every account is a counter:
// a policy filed under an earlier generation is not served.
const planPolicyGenerations = defineNamespace({
  name: 'platform-plan-policy:generation',
  consistency: 'strong',
  schema: z.number(),
  expiry: { ttlMs: null, onUpdate: 'keep' },
})
const currentGeneration = planPolicyGenerations.key('current')

/**
 * Plan policies per platform account: platform host, workspace and member,
 * because seats in one workspace may hold different plans. Fed by every
 * `/v1/account` read, which carries identity and policy together, and by
 * billing reads. Model selection reads it on every turn, so a read never waits
 * on the network unless the account has no entry yet.
 */
class PlatformPlanCache {
  // Loads under way in this process, so its concurrent readers share one.
  private loads = new Map<string, Promise<PlatformPlanPolicy | null>>()

  key(orgId: string | null | undefined, memberId: string | null | undefined): string {
    return JSON.stringify([getPlatformBaseUrl(), orgId ?? null, memberId ?? null])
  }

  /** Record what a platform response said. Saying nothing never replaces an answer. */
  async remember(key: string, policy: PlatformPlanPolicy | null): Promise<void> {
    const { known, generation } = await this.read(key)
    await this.write(key, policy, known, generation)
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
    const { known, generation } = await this.read(key)
    if (known && !options.fresh) {
      if (known.staleAt <= Date.now()) background(this.reload(key, load, generation), { name: 'platform-plan-cache.reload-policy' })
      return known.policy
    }
    return this.reload(key, load, generation)
  }

  /** Forget every account: a refusal proved one stale, or the platform connection changed. */
  async clear(): Promise<void> {
    this.loads.clear()
    await appState().increment(currentGeneration)
  }

  private reload(key: string, load: () => Promise<PlatformPlanPolicy | null>, generation: number): Promise<PlatformPlanPolicy | null> {
    const pending = this.loads.get(key)
    if (pending) return pending
    const next = load()
      .catch(() => null)
      .then(async (policy) => {
        const now = await this.read(key)
        // A load that began before a clear() may carry the policy it cleared.
        if (now.generation !== generation) return now.known?.policy ?? policy
        await this.write(key, policy, now.known, generation)
        return policy ?? now.known?.policy ?? null
      })
      .finally(() => this.loads.delete(key))
    this.loads.set(key, next)
    return next
  }

  /** The account's entry when it belongs to the current generation, and that generation. */
  private async read(key: string): Promise<{ known: StoredPolicy | null; generation: number }> {
    const [entry, raised] = await Promise.all([appState().get(storedKey(key)), appState().get(currentGeneration)])
    const generation = raised?.value ?? 0
    return { known: entry?.value.generation === generation ? entry.value : null, generation }
  }

  private async write(key: string, policy: PlatformPlanPolicy | null, known: StoredPolicy | null, generation: number): Promise<void> {
    await appState().set(storedKey(key), {
      policy: policy ?? known?.policy ?? null,
      staleAt: Date.now() + (policy ? FRESH_MS : UNKNOWN_MS),
      generation,
    })
  }
}

// The cache key names the platform host and account ids, which stay out of an AppState key.
function storedKey(key: string) {
  return planPolicies.key(digestKeyPart(key))
}

export const platformPlanCache = new PlatformPlanCache()
