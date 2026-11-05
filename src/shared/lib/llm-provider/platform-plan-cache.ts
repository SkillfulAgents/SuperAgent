import { randomUUID } from 'node:crypto'
import { appState, defineNamespace, defineTopic, digestKeyPart, type Channel, type Entry } from '@shared/lib/app-state'
import { background } from '@shared/lib/background'
import { getPlatformBaseUrl } from '@shared/lib/platform-auth/config'
import {
  platformPlanChangedEventSchema,
  platformPlanEpochSchema,
  platformPlanSnapshotSchema,
  type PlatformPlanPolicy,
  type PlatformPlanSnapshot,
} from './platform-plan-cache-schema'

export type { PlatformPlanPolicy }

// A plan's model list changes when the plan does, which is rare; a refusal
// (403) or a read after an upgrade replaces it sooner, so it is kept long.
const FRESH_MS = 60 * 60_000
// No answer (an older proxy, or billing was unreachable): ask again sooner.
const UNKNOWN_MS = 10 * 60_000
// How long a stale answer may still be served while reloads fail: from the last
// answer the platform gave, not from the last failed reload.
const RETENTION_MS = 24 * 60 * 60_000

/**
 * Disposable: the upstream proxy enforces the plan, and a read can ask the
 * platform again. So eventual, and every entry goes after {@link RETENTION_MS}.
 */
const planSnapshots = defineNamespace({
  name: 'cache:platform-plan',
  consistency: 'eventual',
  schema: platformPlanSnapshotSchema,
  expiry: { ttlMs: RETENTION_MS, onUpdate: 'reset' },
})

/**
 * Part of every snapshot's key, so a clear makes all of them unreachable, along
 * with any answer still on its way from before the clear. One record, kept
 * forever, so no late write can outlive it. Strong: a stale read here would
 * bring back what a clear forgot.
 */
const planEpochs = defineNamespace({
  name: 'cache:platform-plan:epoch',
  consistency: 'strong',
  schema: platformPlanEpochSchema,
  expiry: { ttlMs: null, onUpdate: 'keep' },
})
const EPOCH_KEY = planEpochs.key('tenant')
const FIRST_EPOCH = 'first'

// Key parts cannot be empty, and an absent id must not equal any real one.
const idPart = (id: string | null) => (id === null ? 'none' : `id-${id}`)

/**
 * Published when an account's answer changes, and on a clear. Nothing subscribes
 * yet. A subscriber must check the viewer may see the account: the channel is
 * only addressed by org and member.
 */
export const platformPlanChanges = defineTopic({ name: 'events:platform:plan', schema: platformPlanChangedEventSchema })
export const platformPlanChannel = (key: Pick<PlatformPlanKey, 'orgId' | 'memberId'>) => platformPlanChanges.channel(idPart(key.orgId), idPart(key.memberId))

/** Which account's plan: the platform, workspace and member, because seats in one workspace may hold different plans. */
export interface PlatformPlanKey {
  platform: string
  orgId: string | null
  memberId: string | null
  /**
   * The connection the answer was read through: a digest of its token. A
   * different connection never reads this entry, even if the clear that should
   * have come with the switch was lost, or the account has no org or member to
   * tell it apart.
   */
  authRevision: string
}

/** Taken before a platform request starts, and handed to {@link PlatformPlanCache.remember} with its answer. */
export interface PlatformPlanRead {
  /** The epoch to file the answer under. Null: AppState could not say, so the answer is not filed. */
  epoch: string | null
  startedAt: number
}

function snapshotKey(key: PlatformPlanKey, epoch: string) {
  return planSnapshots.key(key.platform, idPart(key.orgId), idPart(key.memberId), key.authRevision, epoch)
}

/**
 * The reader's clock judges a writer's `freshUntil`, so skew moves the next
 * reload by that much, which is harmless because the proxy still enforces. An
 * entry further ahead than any writer would stamp it came from a fast clock, so
 * it is not trusted.
 */
function isStale(snapshot: PlatformPlanSnapshot, now: number): boolean {
  return snapshot.freshUntil <= now || snapshot.freshUntil - now > FRESH_MS
}

const samePolicy = (a: PlatformPlanPolicy | null, b: PlatformPlanPolicy | null) => JSON.stringify(a) === JSON.stringify(b)

async function publishChange(channel: Channel<{ revision: string }>, revision: string): Promise<void> {
  try {
    await appState().publish(channel, { revision })
  } catch (error) {
    console.warn('[platform-plan] Could not publish a plan-change hint:', error)
  }
}

/**
 * Plan policies per platform account, shared by every process that serves the
 * tenant. Fed by every `/v1/account` read, which carries identity and policy
 * together, and by billing reads. Model selection reads it on every turn, so a
 * read never waits on the network unless the account has no entry yet. No
 * AppState failure reaches a caller: a read that AppState cannot answer asks the
 * platform, as for an entry that is not there.
 */
class PlatformPlanCache {
  // This process's loads in flight. A clear changes the epoch in their key, so
  // nothing after it joins a load from before it.
  private loads = new Map<string, Promise<PlatformPlanPolicy | null>>()

  key(orgId: string | null | undefined, memberId: string | null | undefined, token: string | null | undefined): PlatformPlanKey {
    return {
      platform: digestKeyPart(getPlatformBaseUrl()),
      orgId: orgId ?? null,
      memberId: memberId ?? null,
      authRevision: token ? digestKeyPart(token) : 'disconnected',
    }
  }

  /** Call it before the request whose answer {@link remember} will file. */
  async beginRead(): Promise<PlatformPlanRead> {
    const startedAt = Date.now()
    try {
      const epoch = await appState().get(EPOCH_KEY)
      return { epoch: epoch?.value ?? FIRST_EPOCH, startedAt }
    } catch (error) {
      console.warn('[platform-plan] Could not read the plan cache epoch; this read will not be cached:', error)
      return { epoch: null, startedAt }
    }
  }

  /**
   * Record what a platform response said, and return the account's answer now.
   * Saying nothing never replaces an answer. An answer from before a clear goes
   * under the old epoch, where nothing reads it. There is no compare-and-set in
   * an eventual namespace, so two writers at once can still lose one's write;
   * the cost is one reload, or a stale answer until its freshness runs out, and
   * the proxy enforces in the meantime.
   */
  async remember(key: PlatformPlanKey, policy: PlatformPlanPolicy | null, read: PlatformPlanRead): Promise<PlatformPlanPolicy | null> {
    if (read.epoch === null) return policy
    const stateKey = snapshotKey(key, read.epoch)
    let written: Entry<PlatformPlanSnapshot>
    let known: PlatformPlanSnapshot | undefined
    try {
      known = (await appState().get(stateKey))?.value
      // A read that began after this one already answered.
      if (known?.policy && known.loadedAt > read.startedAt) return known.policy
      if (!policy && known?.policy) {
        // Ask again sooner, and let it stay no longer than the answer itself would.
        await appState().set(stateKey, { ...known, freshUntil: read.startedAt + UNKNOWN_MS }, { expiry: 'keep' })
        return known.policy
      }
      written = await appState().set(stateKey, {
        policy,
        loadedAt: read.startedAt,
        freshUntil: read.startedAt + (policy ? FRESH_MS : UNKNOWN_MS),
      })
    } catch (error) {
      console.warn('[platform-plan] Could not cache a plan policy:', error)
      return policy
    }
    if (!samePolicy(known?.policy ?? null, policy)) {
      await publishChange(platformPlanChannel(key), written.revision)
    }
    return policy
  }

  /**
   * The account's policy. A cached one is served at once, reloading in the
   * background once stale; a miss, or `fresh`, waits for `load`. Null when
   * nothing is known, which callers read as no restriction, like the proxy.
   */
  async get(
    key: PlatformPlanKey,
    load: () => Promise<PlatformPlanPolicy | null>,
    options: { fresh?: boolean } = {},
  ): Promise<PlatformPlanPolicy | null> {
    const read = await this.beginRead()
    const cached = options.fresh ? null : await this.cachedSnapshot(key, read)
    if (cached) {
      if (isStale(cached, read.startedAt)) background(this.reload(key, load, read), { name: 'platform-plan-cache.reload-policy' })
      return cached.policy
    }
    return this.reload(key, load, read)
  }

  private async cachedSnapshot(key: PlatformPlanKey, read: PlatformPlanRead): Promise<PlatformPlanSnapshot | null> {
    if (read.epoch === null) return null
    try {
      return (await appState().get(snapshotKey(key, read.epoch)))?.value ?? null
    } catch (error) {
      console.warn('[platform-plan] Could not read a cached plan policy:', error)
      return null
    }
  }

  private reload(key: PlatformPlanKey, load: () => Promise<PlatformPlanPolicy | null>, read: PlatformPlanRead): Promise<PlatformPlanPolicy | null> {
    const loadKey = JSON.stringify([key, read.epoch])
    const pending = this.loads.get(loadKey)
    if (pending) return pending
    const next = load()
      .catch(() => null)
      .then((policy) => this.remember(key, policy, read))
      .finally(() => this.loads.delete(loadKey))
    this.loads.set(loadKey, next)
    return next
  }

  /**
   * Forget every account in every process: a refusal proved one stale, or the
   * platform connection changed. It never throws. If it fails, a refusal
   * repeats and clears again, and a new connection has its own entries.
   */
  async clear(): Promise<void> {
    let revision: string
    try {
      revision = (await appState().set(EPOCH_KEY, randomUUID())).revision
    } catch (error) {
      console.warn('[platform-plan] Could not clear the plan cache:', error)
      return
    }
    await publishChange(platformPlanChanges.channel('all-accounts'), revision)
  }
}

export const platformPlanCache = new PlatformPlanCache()
