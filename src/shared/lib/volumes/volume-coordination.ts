/**
 * What every process serving a tenant shares about changes to one remote (a
 * Dropbox or Drive account, a GitHub repo, an S3 bucket): which changes may run
 * now, and which cached listings they made stale. docs/app-state.md has the
 * recipe for a provider.
 *
 * One strong record per remote holds both, so a change claims all its paths and
 * invalidates what it affects in one conditional write. Independent per-path
 * locks could not: they cannot see an ancestor or a descendant, and they cannot
 * be taken atomically.
 *
 * Claims are a queue, in arrival order. A claim's turn comes once nothing ahead
 * of it overlaps: a change waits for every earlier overlapping change, siblings
 * run together, and a folder rename behind child writes is not overtaken by
 * later ones. A claim counts from its arrival, so a waiter renews it too and
 * removes it when it gives up.
 *
 * Clocks. A holder knows only its own: it holds until `sent + ttl` (`lease.ts`
 * has the reasoning). `expiresAt` is written by the holder's clock and read by
 * contenders on theirs, so a contender treats a claim as dead only
 * `VOLUME_CLOCK_MARGIN_MS` past it, and only by a write that removes it. Clocks
 * further apart than the margin can let two overlapping changes run until the
 * pruned holder's next renewal, at most `RENEW_EVERY_MS`, aborts it. The same
 * assumption covers cached listings: past the margin, a reader can call a claim
 * dead while its holder still thinks it holds it, the holder's in-time release
 * then advances nothing, and that reader's listing lasts until its freshness bound.
 *
 * Generations. Each arrival or invalidation advances a counter. A cache entry
 * carries the generation it was read under, and a reader rejects it when a newer
 * invalidation affects its path. A compare-and-set cannot span this record and a
 * separate listing, so a stale fill may land in the cache; nobody trusts it. The
 * record's random `incarnation` is part of every generation, so a generation
 * from before the record expired never matches again, and a slow fill refuses
 * itself rather than succeeding against a missing record.
 *
 * The limit. This coordinates the processes that ask. A request a holder already
 * sent runs on after its claim lapses, so a delayed external write can land after
 * a successor's: provider preconditions (ETag, revision, `IfMatch`) still fence
 * those, and nothing here makes a side effect happen exactly once.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  appState,
  defineNamespace,
  defineTopic,
  digestKeyPart,
  holdRenewing,
  LeaseLostError,
  LeaseWaitTimeoutError,
  reduceRecord,
  type LeaseHolding,
  type RecordChange,
  type StateKey,
} from '../app-state'
import { background } from '../background'

/** How long a claim lasts from its arrival or last renewal, unless renewed. */
export const VOLUME_CLAIM_TTL_MS = 30_000
const RENEW_EVERY_MS = 10_000
/** How far past a claim's `expiresAt` another instance's clock must be to call it dead. */
export const VOLUME_CLOCK_MARGIN_MS = 10_000
/** Live claims one remote may hold, waiting ones included. */
const MAX_CLAIMS = 128
/** Recent changes the record remembers; a generation older than these is stale everywhere. */
const MAX_INVALIDATIONS = 128
/** Paths one change names; more than this counts as the whole remote. */
const MAX_PATHS = 16
/** Each conflict means another write landed, so this is twice the claims that can be writing. */
const MAX_WRITE_ATTEMPTS = MAX_CLAIMS * 2
/** An idle record is dropped: its listings have long expired, and a new incarnation costs a re-read at most. */
const RECORD_TTL_MS = 60 * 60_000
const FIRST_POLL_MS = 50
const LAST_POLL_MS = 1_000

/** The path that covers everything: a claim on it is a coarse, whole-remote claim. */
const WHOLE_REMOTE = ''

/**
 * Which remote a change or a listing belongs to, named by the remote's identity
 * rather than by a mount's: two mounts of one bucket coordinate whatever their
 * credentials or prefixes. `origin` is what `s3Namespace` derives, so region is
 * part of it on AWS and an arbitrary label elsewhere does not split a bucket.
 */
export type VolumeRemote =
  | { readonly provider: 'dropbox' | 'googledrive'; readonly accountId: string }
  | { readonly provider: 'github'; readonly repoId: string }
  | { readonly provider: 's3'; readonly origin: string; readonly bucket: string }

/** The key parts for a remote. Its identity may be sensitive (a bucket name), so it is always digested. */
function remoteParts(remote: VolumeRemote): [string, string] {
  const identity = remote.provider === 's3' ? [remote.origin, remote.bucket] : remote.provider === 'github' ? [remote.repoId] : [remote.accountId]
  return [remote.provider, digestKeyPart(JSON.stringify(identity))]
}

const counter = z.number().int().nonnegative()
const pathList = z.array(z.string()).max(MAX_PATHS)

/**
 * The generation a listing was read under, or a claim's fencing token. Embed it
 * in a cache entry's schema. Compare it only through `isCurrent`.
 */
export const volumeGenerationSchema = z.object({ incarnation: z.uuid(), generation: counter })
export type VolumeGeneration = z.infer<typeof volumeGenerationSchema>

const claimSchema = z.object({
  /** This arrival's owner id: only it renews or removes the claim. */
  id: z.uuid(),
  /** What the change conflicts over: each path and what is under it. */
  paths: pathList.min(1),
  /** What it makes stale (see `makesStale`). */
  invalidates: pathList,
  /** Epoch ms by the holder's clock. Other instances judge it with `VOLUME_CLOCK_MARGIN_MS`. */
  expiresAt: z.number().int(),
})
type Claim = z.infer<typeof claimSchema>

const recordSchema = z.object({
  /** New each time the record is created, so generations stay unique across its expiry. */
  incarnation: z.uuid(),
  generation: counter,
  /** Generations below this may have missed an invalidation no longer remembered. */
  floor: counter,
  /** Oldest first. */
  invalidations: z.array(z.object({ generation: counter, paths: pathList.min(1) })).max(MAX_INVALIDATIONS),
  /** In arrival order: the queue. */
  claims: z.array(claimSchema).max(MAX_CLAIMS),
})
export type VolumeCoordinationRecord = z.infer<typeof recordSchema>

/** The ticket's `coord:volume:{provider}:{remoteScope}`. The tenant comes from AppState's own key prefix. */
const records = defineNamespace({
  name: 'coord:volume',
  consistency: 'strong',
  schema: recordSchema,
  // Every write resets it, so a record outlives any claim whose holder is renewing.
  expiry: { ttlMs: RECORD_TTL_MS, onUpdate: 'reset' },
})

/** Only wakes waiters to look again: ownership is decided by the record alone. */
const releases = defineTopic({ name: 'events:volume:mutation-released', schema: z.object({}) })

/** A remote's record, for tests and diagnostics. Only this module writes it. */
export function volumeCoordinationKey(remote: VolumeRemote): StateKey<VolumeCoordinationRecord, 'strong'> {
  return records.key(...remoteParts(remote))
}

const normalized = (path: string) => (path.endsWith('/') ? path.slice(0, -1) : path)

function pathsOf(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map(normalized))]
  return unique.length > MAX_PATHS ? [WHOLE_REMOTE] : unique
}

const isWithin = (path: string, ancestor: string) => ancestor === WHOLE_REMOTE || path === ancestor || path.startsWith(`${ancestor}/`)
const overlap = (a: readonly string[], b: readonly string[]) => a.some(x => b.some(y => isWithin(x, y) || isWithin(y, x)))
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0))

/** A change at a path affects that path's listing, everything under it, and its parent's listing. */
const makesStale = (changed: string, listing: string) => isWithin(listing, changed) || listing === parentOf(changed)

/** Judged on this instance's clock, about a deadline another instance's clock may have written. */
const isDead = (claim: Claim, now: number) => now >= claim.expiresAt + VOLUME_CLOCK_MARGIN_MS

/**
 * An owner's own claim while it still holds, judged on the clock that wrote its
 * deadline, so with no margin. Being in the record proves nothing: a dead claim
 * stays there until someone's write removes it.
 */
const heldClaim = (claims: readonly Claim[], id: string, now: number) => claims.find(claim => claim.id === id && now < claim.expiresAt)

function newRecord(): VolumeCoordinationRecord {
  return { incarnation: randomUUID(), generation: 0, floor: 0, invalidations: [], claims: [] }
}

const generationOf = (record: VolumeCoordinationRecord): VolumeGeneration => ({ incarnation: record.incarnation, generation: record.generation })

/** The record with its generation advanced, remembering `changed` when there is any. */
function withChange(record: VolumeCoordinationRecord, changed: string[]): VolumeCoordinationRecord {
  const generation = record.generation + 1
  if (changed.length === 0) return { ...record, generation }
  const invalidations = [...record.invalidations, { generation, paths: changed }]
  const forgotten = invalidations.length > MAX_INVALIDATIONS ? invalidations.shift() : undefined
  return { ...record, generation, invalidations, floor: forgotten?.generation ?? record.floor }
}

function isCurrentIn(record: VolumeCoordinationRecord, stamp: VolumeGeneration, listing: string, ownGeneration?: number): boolean {
  if (stamp.incarnation !== record.incarnation || stamp.generation < record.floor) return false
  return !record.invalidations.some(change => change.generation > stamp.generation
    && change.generation !== ownGeneration
    && change.paths.some(changed => makesStale(changed, listing)))
}

const write = <R>(key: StateKey<VolumeCoordinationRecord, 'strong'>, reduce: (record: VolumeCoordinationRecord | null) => RecordChange<VolumeCoordinationRecord, R>) =>
  reduceRecord(key, reduce, { maxAttempts: MAX_WRITE_ATTEMPTS })

/**
 * The generation to read `path` under, taken before reading the source. Null
 * while a change that affects it is in line or running: read the source and
 * return the result, but do not cache it, since that change may land right after.
 */
export async function beginVolumeRead(remote: VolumeRemote, path: string): Promise<VolumeGeneration | null> {
  const listing = normalized(path)
  return await write(volumeCoordinationKey(remote), (record) => {
    const current = record ?? newRecord()
    const now = Date.now()
    const changing = current.claims.some(claim => !isDead(claim, now) && claim.invalidates.some(changed => makesStale(changed, listing)))
    const result = changing ? null : generationOf(current)
    // Created when absent, so a generation always names an incarnation that exists.
    return record ? { result } : { result, value: current }
  })
}

/** One read of a remote's generations, to check any number of cached listings against. */
export interface VolumeGenerations {
  /** Whether a listing of `path` read under `stamp` may be served: nothing affecting it has changed since. */
  isCurrent(stamp: VolumeGeneration, path: string): boolean
}

export async function readVolumeGenerations(remote: VolumeRemote): Promise<VolumeGenerations> {
  const record = (await appState().get(volumeCoordinationKey(remote)))?.value ?? null
  // No record means its incarnation is gone, and every generation with it.
  return { isCurrent: (stamp, path) => record !== null && isCurrentIn(record, stamp, normalized(path)) }
}

/**
 * Marks `paths` changed, without a claim: for a change learned of from outside,
 * such as a change feed. With no paths, every listing of the remote is stale.
 */
export async function advanceVolumeGeneration(remote: VolumeRemote, paths?: readonly string[]): Promise<VolumeGeneration> {
  const changed = paths ? pathsOf(paths) : [WHOLE_REMOTE]
  return await write(volumeCoordinationKey(remote), (record) => {
    const value = withChange(record ?? newRecord(), changed)
    return { result: generationOf(value), value }
  })
}

export interface VolumeClaimRequest {
  /**
   * What the change conflicts over: each path and what is under it, normalized
   * as the provider's listings are (Dropbox lower-cases). Omit it to claim the
   * whole remote, for a provider that does not need path overlap.
   */
  readonly paths?: readonly string[]
  /**
   * Whose listings it makes stale: each path, what is under it, and its parent.
   * Default `paths`. A coarse claim still names only what it changes here, so
   * unrelated listings stay cached. Pass `[]` for a change no listing shows.
   */
  readonly invalidates?: readonly string[]
  /** How long to wait in line; then `LeaseWaitTimeoutError`. */
  readonly waitTimeoutMs: number
  /** The operation's deadline, from its turn: renewals stop and its signal aborts then. */
  readonly holdTimeoutMs: number
  /** Cancels the wait, which leaves nothing behind. Also aborts the claim's signal. */
  readonly signal?: AbortSignal
}

/** What a change gets while it runs. `confirm` renews, as `LeaseHolding.confirm` does. */
export interface VolumeClaim extends LeaseHolding {
  /**
   * This claim's fencing token. Stamp what it publishes with it: once a later
   * change affecting that path arrives, readers reject the entry, however late
   * it lands.
   */
  readonly generation: VolumeGeneration
  /**
   * Whether a listing read under `stamp` can be updated in place and republished:
   * this claim is still held (not lost, and before its own deadline), and nothing
   * but this change has affected the listing since.
   */
  isCurrent(stamp: VolumeGeneration, path: string): Promise<boolean>
}

interface Arrival {
  readonly generation: VolumeGeneration
  readonly turnCame: boolean
}

function arriveIn(record: VolumeCoordinationRecord | null, claim: Omit<Claim, 'expiresAt'>): RecordChange<VolumeCoordinationRecord, Arrival | null> {
  const now = Date.now()
  const base = record ?? newRecord()
  const claims = base.claims.filter(other => !isDead(other, now))
  if (claims.length >= MAX_CLAIMS) return { result: null }
  const value = withChange({ ...base, claims: [...claims, { ...claim, expiresAt: now + VOLUME_CLAIM_TTL_MS }] }, claim.invalidates)
  return { result: { generation: generationOf(value), turnCame: !claims.some(other => overlap(other.paths, claim.paths)) }, value }
}

/** Whether nothing live ahead of `mine` overlaps it. */
function turnCameFor(claims: readonly Claim[], mine: Claim, now: number): boolean {
  return !claims.slice(0, claims.indexOf(mine)).some(other => !isDead(other, now) && overlap(other.paths, mine.paths))
}

/**
 * Extends the claim and removes dead ones, so a turn that came by a dead claim
 * ahead is recorded by the same write: that holder's own renewal now finds its
 * claim gone. Null once the claim is gone or lapsed, by the clock that wrote it.
 */
function renewIn(record: VolumeCoordinationRecord | null, id: string): RecordChange<VolumeCoordinationRecord, { turnCame: boolean } | null> {
  const now = Date.now()
  const held = heldClaim(record?.claims ?? [], id, now)
  if (!record || !held) return { result: null }
  const mine = { ...held, expiresAt: now + VOLUME_CLAIM_TTL_MS }
  const claims = record.claims.filter(claim => !isDead(claim, now)).map(claim => (claim.id === id ? mine : claim))
  return { result: { turnCame: turnCameFor(claims, mine, now) }, value: { ...record, claims } }
}

/**
 * Removes this owner's claim, never anyone else's, and says whether a remaining
 * claim may be waiting on it. A claim gone or past its deadline lapsed while its
 * work ran, so a request it sent may have landed after someone's read: its paths
 * are marked changed again, now that its work has settled. One still held needs
 * no second advance: `beginVolumeRead` gives no generation for what it affects.
 */
function leaveIn(record: VolumeCoordinationRecord | null, id: string, paths: readonly string[], invalidates: string[]): RecordChange<VolumeCoordinationRecord, boolean> {
  if (!record) return { result: false }
  const now = Date.now()
  const held = heldClaim(record.claims, id, now)
  const claims = record.claims.filter(claim => claim.id !== id && !isDead(claim, now))
  const result = claims.some(claim => overlap(claim.paths, paths))
  return { result, value: held ? { ...record, claims } : withChange({ ...record, claims }, invalidates) }
}

/** A wake that arrives while the waiter is busy ends its next pause at once. */
function createWake() {
  let rung = false
  let wakeWaiter: (() => void) | undefined
  return {
    ring() {
      rung = true
      wakeWaiter?.()
    },
    pause(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const finish = (settle: () => void) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          wakeWaiter = undefined
          rung = false
          settle()
        }
        const onAbort = () => finish(() => reject(signal.reason))
        const timer = setTimeout(() => finish(resolve), ms)
        wakeWaiter = () => finish(resolve)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        else if (rung) finish(resolve)
      })
    },
  }
}

/**
 * Runs `work` as a change to `remote`: queues the claim, waits until nothing ahead
 * of it overlaps, and keeps it renewed until the work settles. `claim.signal`
 * aborts with `LeaseLostError` when the claim is lost, or at `holdTimeoutMs`, and
 * with the request's own reason when `request.signal` aborts.
 *
 * Call `claim.confirm({ minRemainingMs })` right before each provider write, with
 * nothing awaited in between, and keep the write's own precondition. Not
 * re-entrant: a nested overlapping claim waits for its own outer claim.
 */
export async function withVolumeClaim<T>(remote: VolumeRemote, request: VolumeClaimRequest, work: (claim: VolumeClaim) => Promise<T>): Promise<T> {
  request.signal?.throwIfAborted()
  if (request.paths?.length === 0) throw new TypeError('A volume claim names at least one path; omit `paths` to claim the whole remote')
  const key = volumeCoordinationKey(remote)
  const id = randomUUID()
  const paths = request.paths ? pathsOf(request.paths) : [WHOLE_REMOTE]
  const invalidates = request.invalidates ? pathsOf(request.invalidates) : paths
  const channel = releases.channel(...remoteParts(remote))

  const leave = async () => {
    const someoneWaits = await write(key, record => leaveIn(record, id, paths, invalidates))
    // Only a wake: a lost one costs a waiter one poll, so it is not worth reporting.
    if (someoneWaits) background(appState().publish(channel, {}).catch(() => {}), { name: 'volume-coordination.wake' })
  }

  const sentAt = Date.now()
  const waitUntil = sentAt + request.waitTimeoutMs
  let arrival: Arrival | null
  try {
    arrival = await write(key, record => arriveIn(record, { id, paths, invalidates }))
  } catch (error) {
    // The write may have landed, with only its answer lost.
    await leave().catch(() => {})
    throw error
  }
  if (!arrival) throw new LeaseWaitTimeoutError(`${key.path}: ${MAX_CLAIMS} changes are already in line`)
  const { generation } = arrival

  const turn = { came: false, holdUntil: Number.POSITIVE_INFINITY }
  const startTurn = () => {
    turn.came = true
    turn.holdUntil = Date.now() + request.holdTimeoutMs
  }
  if (arrival.turnCame) startTurn()
  // Counted from when the write was sent: it can only have landed after that.
  const heldUntilFrom = (sent: number) => Math.min(sent + VOLUME_CLAIM_TTL_MS, turn.holdUntil)

  return await holdRenewing({ heldUntil: heldUntilFrom(sentAt) }, {
    owner: id,
    label: key.path,
    renewEveryMs: RENEW_EVERY_MS,
    async renew() {
      const sent = Date.now()
      if (sent >= turn.holdUntil) return null
      const renewed = await write(key, record => renewIn(record, id))
      if (!renewed) return null
      if (renewed.turnCame && !turn.came) startTurn()
      // An answer that came at or after this counts as lost: `holdRenewing` sees it already passed.
      return { heldUntil: heldUntilFrom(sent) }
    },
    release: leave,
  }, async (holding) => {
    if (Date.now() >= heldUntilFrom(sentAt)) throw new LeaseLostError(`${key.path}: the claim's arrival was answered too late to rely on`)
    const signal = request.signal ? AbortSignal.any([holding.signal, request.signal]) : holding.signal
    if (!turn.came) {
      const wake = createWake()
      // PubSub only shortens the wait: with no subscription, the polling below still finds the turn.
      const subscription = await appState().subscribe([channel], () => wake.ring()).catch(() => null)
      try {
        for (let pause = FIRST_POLL_MS; ; pause = Math.min(pause * 2, LAST_POLL_MS)) {
          signal.throwIfAborted()
          const claims = (await appState().get(key))?.value.claims ?? []
          const now = Date.now()
          const mine = heldClaim(claims, id, now)
          // The turn is taken by the renewal's write, not by this read. A claim
          // gone or lapsed gets its answer from the renewal too: lost.
          if (!mine || turnCameFor(claims, mine, now)) await holding.confirm()
          if (turn.came) break
          const remaining = waitUntil - Date.now()
          if (remaining <= 0) throw new LeaseWaitTimeoutError(`${key.path}: earlier changes held it for over ${request.waitTimeoutMs} ms`)
          await wake.pause(Math.min(pause, remaining), signal)
        }
      } finally {
        await subscription?.unsubscribe().catch(() => {})
      }
    }
    signal.throwIfAborted()
    return await work({
      owner: holding.owner,
      signal,
      confirm: holding.confirm,
      generation,
      async isCurrent(stamp, path) {
        const record = (await appState().get(key))?.value
        // The record can still list a claim its holder was told it lost: at the
        // operation's deadline, or when a renewal could not be confirmed.
        if (!record || holding.signal.aborted || !heldClaim(record.claims, id, Date.now())) return false
        return isCurrentIn(record, stamp, normalized(path), generation.generation)
      },
    })
  })
}
