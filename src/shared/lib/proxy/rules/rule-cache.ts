/**
 * The live rules of each target, shared by every process that serves the
 * tenant, so the proxies' hot path skips the database. The database stays
 * canonical. These rules are policy, so the namespace is strong, and no read
 * sees rules older than the ceiling even if every invalidation and hint is
 * lost. docs/app-state.md § Policy caches has the reasoning.
 */
import { randomUUID } from 'node:crypto'
import { appState, defineNamespace, defineTopic, type Revision, type StateKey } from '@shared/lib/app-state'
import type { RuleTarget } from './store'
import { ruleCacheRecordSchema, ruleChangedEventSchema, type CachedRule, type RuleCacheRecord } from './rule-cache-schema'

/** The longest a snapshot serves, counted from before its database read began. */
export const RULE_CACHE_TTL_MS = 5_000

const ruleCache = defineNamespace({
  name: 'cache:proxy-rules',
  consistency: 'strong',
  schema: ruleCacheRecordSchema,
  expiry: { ttlMs: RULE_CACHE_TTL_MS, onUpdate: 'reset' },
})

type RuleCacheKey = StateKey<RuleCacheRecord, 'strong'>

const targetKey = (target: RuleTarget): RuleCacheKey => ruleCache.key(target.kind, target.targetId)

/** The all-targets epoch: one record, kept forever, so no late fill can outlive it. */
export const allTargetsEpochKey: RuleCacheKey = ruleCache.key('all-targets')

/** Published after an invalidation. Nothing subscribes yet; freshness never depends on it. */
export const ruleChanges = defineTopic({ name: 'events:proxy-rules:changed', schema: ruleChangedEventSchema })

/** One load in this process. The Promise cannot be shared; what it publishes can. */
interface Fill {
  epoch: string | null
  startedAt: number
  /** Still creating its record, so its database read has not begun. */
  claiming: boolean
  /** The record it publishes over. Null when it could not get one: it then publishes nothing. */
  revision: Revision | null
  rules: Promise<CachedRule[]>
}

const fills = new Map<string, Fill>()

/**
 * A reader joins a load only if the load is sure to see every invalidation the
 * reader saw. A load still claiming has not read the database yet. Otherwise
 * the record must still be the one the load started from, since an
 * invalidation or an expiry retires that revision for good, and records live
 * at most the ceiling, so a load found this way is not older than that either.
 */
function canJoin(fill: Fill, epoch: string | null, revision: Revision | undefined): boolean {
  if (fill.epoch !== epoch) return false
  return fill.claiming || (fill.revision !== null && fill.revision === revision)
}

/**
 * The target's rules: the snapshot while it lasts, else `load`, shared with
 * this process's other readers. The one AppState read is the whole cost of a
 * hit. When AppState cannot answer, the database does, on every request.
 */
export async function cachedRules(target: RuleTarget, load: () => Promise<CachedRule[]>): Promise<CachedRule[]> {
  const key = targetKey(target)
  let stored
  try {
    stored = await appState().getMany([allTargetsEpochKey, key])
  } catch (error) {
    console.warn('[proxy-rules] Could not read cached rules; reading the database:', error)
    return load()
  }
  const epoch = stored[0]?.value.epoch ?? null
  const entry = stored[1]
  if (entry?.value.rules && entry.value.epoch === epoch) return entry.value.rules

  const inFlight = fills.get(key.path)
  if (inFlight && canJoin(inFlight, epoch, entry?.revision)) return inFlight.rules
  return startFill(key, epoch, entry?.revision ?? null, load).rules
}

function startFill(key: RuleCacheKey, epoch: string | null, revision: Revision | null, load: () => Promise<CachedRule[]>): Fill {
  const fill = {
    epoch,
    // Before the database read begins, so a slow read earns no extra freshness.
    startedAt: Date.now(),
    claiming: revision === null,
    revision,
  } as Fill
  fill.rules = runFill(fill, key, load).finally(() => {
    if (fills.get(key.path) === fill) fills.delete(key.path)
  })
  fills.set(key.path, fill)
  return fill
}

async function runFill(fill: Fill, key: RuleCacheKey, load: () => Promise<CachedRule[]>): Promise<CachedRule[]> {
  if (fill.claiming) {
    fill.revision = await claimRecord(key, fill.epoch)
    fill.claiming = false
  }
  const rules = await load()
  if (fill.revision) await publishSnapshot(fill, fill.revision, key, rules)
  return rules
}

/**
 * Makes sure the key holds a record, and returns its revision. A fill never
 * publishes over "absent": an invalidation record that expired while a slow
 * load ran would let it. It publishes over this revision, which an
 * invalidation or an expiry retires for good, so late work refuses itself.
 */
async function claimRecord(key: RuleCacheKey, epoch: string | null): Promise<Revision | null> {
  try {
    const claim = await appState().insertIfAbsent(key, { epoch, rules: null })
    return claim.inserted ? claim.entry.revision : claim.current.revision
  } catch (error) {
    console.warn('[proxy-rules] Could not claim a cached-rules record; this load will not be cached:', error)
    return null
  }
}

/**
 * Publishes for what is left of the ceiling. AppState's clock judges the expiry
 * and this process's clock only measures its own elapsed time, so clock skew
 * plays no part. A conflict means an invalidation or another load got there
 * first, and either way this snapshot is not needed.
 */
async function publishSnapshot(fill: Fill, revision: Revision, key: RuleCacheKey, rules: CachedRule[]): Promise<void> {
  const ttlMs = RULE_CACHE_TTL_MS - (Date.now() - fill.startedAt)
  if (ttlMs <= 0) return
  try {
    await appState().compareAndSet(key, revision, { epoch: fill.epoch, rules }, { expiry: { ttlMs } })
  } catch (error) {
    console.warn('[proxy-rules] Could not publish cached rules:', error)
  }
}

/**
 * Forget cached rules in every process: one target's, or every target's. Call
 * it after the database write committed. It never throws: the write stands, and
 * if this fails, snapshots already published run out at the ceiling.
 */
export async function invalidateRuleCache(target?: RuleTarget): Promise<void> {
  let revision: Revision
  try {
    // A new write retires the revision any load in flight would publish over.
    // A new epoch retires every snapshot stamped with an older one, whenever it lands.
    const written = target
      ? await appState().set(targetKey(target), { epoch: null, rules: null })
      : await appState().set(allTargetsEpochKey, { epoch: randomUUID(), rules: null }, { expiry: 'never' })
    revision = written.revision
  } catch (error) {
    console.warn(`[proxy-rules] Could not invalidate cached rules; they can serve for up to ${RULE_CACHE_TTL_MS} ms more:`, error)
    return
  }
  try {
    const channel = target ? ruleChanges.channel(target.kind, target.targetId) : ruleChanges.channel('all-targets')
    await appState().publish(channel, { revision })
  } catch (error) {
    console.warn('[proxy-rules] Could not publish a rule-change hint:', error)
  }
}
