/**
 * An agent's session index: one entry per session, holding what the app
 * keeps about it and its transcript as last seen.
 *
 * It is the agent's own, like its files: the actor reaches it through
 * `SessionIndexStorage`, and where the entries live is the runtime's choice
 * (a table of the app database for an actor in this process, the actor's own
 * storage for one that runs elsewhere). Nothing outside the actor reads it.
 *
 * Two authorities meet here. For what the app keeps (name, star, how the
 * session was started) the index is the truth. For whether a session exists
 * the transcripts directory is: the CLI and the agent create and remove
 * transcripts without telling anyone, so a read first reconciles the index
 * with the directory. That costs one stat while the directory is unchanged,
 * one listing when it changed, and a stat only of a transcript the index has
 * not seen. A transcript's last activity is then kept by the writes recorded
 * here (`recordActivity`), never by statting it again.
 */
import pLimit from 'p-limit'
import { background } from '@shared/lib/background'
import type { SessionMetadata, SessionMetadataMap } from '@shared/lib/types/agent'
import { isSessionIdWellFormed } from './session-store'
import type { StoreFileOps } from './types'
import { WorkspaceFileError, joinWorkspacePath } from './workspace-path'

/** A transcript as the index last saw it: one stat, then kept current by recorded writes. */
export interface TranscriptStat {
  mtimeMs: number
  /** 0 where the store reports no birth time. */
  birthtimeMs: number
  size: number
}

export interface SessionIndexEntry {
  sessionId: string
  /** What the app keeps about the session; null for a transcript nobody registered. */
  meta: SessionMetadata | null
  /** Null until a transcript has been seen. */
  transcript: TranscriptStat | null
}

/** A mutator's answer that removes the entry. */
export const REMOVE_SESSION = Symbol('remove-session')

/** The metadata fields a session can be looked up by. */
export type SessionLookupField = 'scheduledTaskId' | 'webhookTriggerId'

/**
 * Where an agent's index entries are stored. Every operation is on one
 * agent's entries; an implementation never sees another agent's.
 */
export interface SessionIndexStorage {
  get(sessionId: string): Promise<SessionIndexEntry | null>
  list(): Promise<SessionIndexEntry[]>
  /** The entries whose metadata has `value` in `field`. */
  findByMeta(field: SessionLookupField, value: string): Promise<SessionIndexEntry[]>
  /**
   * Read-modify-write of one entry's metadata, safe against concurrent
   * writers. `mutate` answers the new metadata, `REMOVE_SESSION`, or null to
   * leave the entry as it is. It may run more than once, so it must be
   * synchronous and free of side effects beyond what it assigns.
   */
  update(
    sessionId: string,
    mutate: (current: SessionIndexEntry | null) => SessionMetadata | typeof REMOVE_SESSION | null,
  ): Promise<void>
  /**
   * Add what the stored entries lack: an entry that does not exist, metadata
   * where there is none, a transcript where none has been seen. What is
   * already stored always wins.
   */
  fill(entries: readonly SessionIndexEntry[]): Promise<void>
  /**
   * Activity on sessions whose transcript has been seen, as session id →
   * epoch ms. Never moves an entry back. A session without an entry, or
   * whose transcript has not been seen, is left alone: its id is returned.
   */
  touch(activity: ReadonlyMap<string, number>): Promise<string[]>
  delete(sessionIds: readonly string[]): Promise<void>
}

/** What undoes one provisional record (see `recordProvisionalActivity`). */
export interface SessionActivityMark {
  recordedAtMs: number
  /** The provisional activity the record replaced, if any. */
  previousMs: number | null
}

export interface SessionIndexDeps {
  files: StoreFileOps
  transcriptsDir: string
  /** Identifies the storage behind `files`; what was learned from one directory is never applied to another. */
  key: () => string
  storage: SessionIndexStorage
  /** {@link DIRECTORY_TICK_MS}, for a test over a filesystem whose clock it knows. */
  directoryTickMs?: number
}

/**
 * The coarsest clock a filesystem is expected to stamp a directory with. A
 * change made in the same tick as the one before it leaves the directory's
 * mtime as it was, and network filesystems tick as slowly as once a second.
 */
export const DIRECTORY_TICK_MS = 2_000

/**
 * A directory whose mtime is this far behind the host's clock has not
 * changed within a tick, whatever the two clocks disagree by.
 */
const LONG_UNCHANGED_MS = 60_000

/** What the index last learned from the transcripts directory. */
interface Reconciled {
  key: string
  directoryMtimeMs: number | null
  /** When (host clock) this mtime was first seen on the directory. */
  firstSeenAtMs: number
  /**
   * Whether the mtime can be trusted to mean "nothing changed since": only
   * once the directory was listed a whole tick after the mtime was first
   * seen (or was long unchanged by then). Until that, a change in the same
   * tick as the listing would go unseen, so every read lists again.
   */
  settled: boolean
  /**
   * The transcripts the directory held, so a listing that finds the same
   * ones stops there. Forgotten when an entry is deleted: the transcript of
   * a session deleted and made again under its id is one to take in.
   */
  present?: ReadonlySet<string>
}

/**
 * `storage`, holding on to what it last listed until it next writes.
 *
 * An index is the only writer of its agent's storage for as long as it
 * lives (the agent's actor owns both), so nothing can change the entries
 * behind its back, and listing them again would only read the same rows:
 * for an agent with 20,000 sessions that is tens of milliseconds, on every
 * poll of the agents list. What is listed is frozen: every reader is handed
 * the same entries.
 */
function remembering(storage: SessionIndexStorage): SessionIndexStorage {
  let listed: Promise<SessionIndexEntry[]> | undefined
  // Forgotten before and after: a listing that starts while the write is
  // under way may or may not see it.
  const writing = async <T>(write: () => Promise<T>): Promise<T> => {
    listed = undefined
    try {
      return await write()
    } finally {
      listed = undefined
    }
  }
  return {
    get: (sessionId) => storage.get(sessionId),
    findByMeta: (field, value) => storage.findByMeta(field, value),
    list: () => {
      if (listed) return listed
      const listing = storage.list().then((entries) => {
        for (const entry of entries) {
          if (entry.meta) Object.freeze(entry.meta)
          if (entry.transcript) Object.freeze(entry.transcript)
          Object.freeze(entry)
        }
        return Object.freeze(entries) as SessionIndexEntry[]
      })
      listed = listing
      // A failed listing is not one to hand out again.
      listing.catch(() => {
        if (listed === listing) listed = undefined
      })
      return listing
    },
    update: (sessionId, mutate) => writing(() => storage.update(sessionId, mutate)),
    fill: (entries) => (entries.length === 0 ? Promise.resolve() : writing(() => storage.fill(entries))),
    touch: (activity) => (activity.size === 0 ? Promise.resolve([]) : writing(() => storage.touch(activity))),
    delete: (sessionIds) => (sessionIds.length === 0 ? Promise.resolve() : writing(() => storage.delete(sessionIds))),
  }
}

export class SessionIndex {
  private readonly storage: SessionIndexStorage
  private reconciled: Reconciled | undefined
  private reconciling: { run: Promise<void>; startedAtMs: number } | undefined
  /** Counts {@link lookAgain}: a run it was called during does not get to say the directory was seen. */
  private lookAgainCalls = 0
  /** Recorded activity not yet stored. */
  private pending = new Map<string, number>()
  private flushing: Promise<void> | undefined
  /**
   * Activity recorded for a session whose transcript the index has not seen
   * (a send is recorded before the CLI writes): stored once reconciliation
   * finds the transcript, whose own mtime may not carry the write yet.
   */
  private readonly awaitingTranscript = new Map<string, number>()
  private steps: Promise<unknown> = Promise.resolve()
  /** Activity of sends that may still be taken back: shown, never stored. */
  private readonly provisional = new Map<string, number>()

  constructor(private readonly deps: SessionIndexDeps) {
    this.storage = remembering(deps.storage)
  }

  get(sessionId: string): Promise<SessionIndexEntry | null> {
    return this.storage.get(sessionId)
  }

  update(...args: Parameters<SessionIndexStorage['update']>): Promise<void> {
    return this.storage.update(...args)
  }

  /**
   * Take in what a `session-metadata.json` says (see `session-metadata-file`).
   * Stored metadata always wins, so taking a file in twice changes nothing.
   *
   * An entry the index has only from a stat gives way to one that says when
   * its transcript was last written: an agent being imported is already
   * listed while its files are extracted, and a transcript statted then
   * says when it was imported, not when it was last active.
   */
  fill(entries: readonly SessionIndexEntry[]): Promise<void> {
    return this.inOrder(async () => {
      const { storage } = this
      const dated = new Set(entries.filter((entry) => entry.meta && entry.transcript).map((entry) => entry.sessionId))
      if (dated.size > 0) {
        const statOnly = (await storage.list()).filter((entry) => !entry.meta && dated.has(entry.sessionId))
        await storage.delete(statOnly.map((entry) => entry.sessionId))
      }
      await storage.fill(entries)
    })
  }

  delete(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.pending.delete(sessionId)
      this.provisional.delete(sessionId)
      this.awaitingTranscript.delete(sessionId)
    }
    if (this.reconciled) this.reconciled.present = undefined
    return this.storage.delete(sessionIds)
  }

  /** What the app keeps about every session it knows of. No storage beyond the index is touched. */
  async metadata(): Promise<SessionMetadataMap> {
    const entries = await this.storage.list()
    return Object.fromEntries(entries.flatMap(({ sessionId, meta }) => (meta ? [[sessionId, meta]] : [])))
  }

  /** Every entry, reconciled with the transcripts directory and carrying all recorded activity. */
  async entries(): Promise<SessionIndexEntry[]> {
    await this.upToDate()
    return (await this.storage.list()).map((entry) => this.withProvisional(entry))
  }

  /**
   * Something says the directory holds a transcript the index has not seen:
   * the next read lists it again, whatever its mtime says. A directory's
   * mtime is the only signal otherwise, and it cannot tell two changes in
   * one tick of the filesystem's clock apart.
   */
  lookAgain(): void {
    this.reconciled = undefined
    this.lookAgainCalls += 1
  }

  /** {@link entries}, narrowed to the sessions whose metadata has `value` in `field`. */
  async entriesByMeta(field: SessionLookupField, value: string): Promise<SessionIndexEntry[]> {
    await this.upToDate()
    return (await this.storage.findByMeta(field, value)).map((entry) => this.withProvisional(entry))
  }

  /**
   * A write reached a session's transcript. Synchronous for its callers (a
   * stream frame handler does not wait on storage): the write is stored
   * behind them, one batch at a time, and every read waits for it.
   */
  recordActivity(sessionId: string, activityAtMs: number): void {
    // The write settles a provisional record: the turn it announced is real.
    const provisional = this.provisional.get(sessionId)
    this.provisional.delete(sessionId)
    this.keep(this.pending, sessionId, Math.max(provisional ?? -Infinity, activityAtMs))
    if (!this.flushing) background(this.flush(), { name: 'session-index.store-activity' })
  }

  /**
   * A write that may still be rolled back: an optimistic send that has not
   * reached the container. It moves the session up in what is read, and is
   * stored only once a real write follows it.
   */
  recordProvisionalActivity(sessionId: string, activityAtMs: number): SessionActivityMark {
    const previousMs = this.provisional.get(sessionId) ?? null
    this.provisional.set(sessionId, Math.max(previousMs ?? -Infinity, activityAtMs))
    return { recordedAtMs: activityAtMs, previousMs }
  }

  /** Undo a provisional record whose send never happened. A no-op once anything was recorded after it. */
  revertProvisionalActivity(sessionId: string, mark: SessionActivityMark): void {
    if (this.provisional.get(sessionId) !== mark.recordedAtMs) return
    if (mark.previousMs === null) this.provisional.delete(sessionId)
    else this.provisional.set(sessionId, mark.previousMs)
  }

  private withProvisional(entry: SessionIndexEntry): SessionIndexEntry {
    const provisional = this.provisional.get(entry.sessionId)
    if (provisional === undefined || !entry.transcript) return entry
    return {
      ...entry,
      transcript: {
        ...entry.transcript,
        mtimeMs: Math.max(entry.transcript.mtimeMs, provisional),
        size: Math.max(entry.transcript.size, 1),
      },
    }
  }

  /**
   * Everything recorded is stored and the directory is reconciled. Activity
   * is stored first: activity for a transcript the index has not seen is
   * what says to look at the directory again. And once more after, for the
   * activity that was waiting for a transcript the directory just gave up.
   */
  private async upToDate(): Promise<void> {
    await this.flush()
    await this.reconcile()
    await this.flush()
  }

  /** Store the recorded activity. Concurrent callers share one run. */
  private flush(): Promise<void> {
    if (!this.flushing && this.pending.size === 0) return Promise.resolve()
    this.flushing ??= this.storePending().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  private async storePending(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = this.pending
      this.pending = new Map()
      try {
        await this.inOrder(async () => {
          for (const sessionId of await this.storage.touch(batch)) {
            this.keep(this.awaitingTranscript, sessionId, batch.get(sessionId)!)
            // A write to a transcript the index has not seen: look for it.
            this.lookAgain()
          }
        })
      } catch (error) {
        // Kept for the next flush, under whatever was recorded meanwhile.
        for (const [sessionId, at] of batch) this.keep(this.pending, sessionId, at)
        throw error
      }
    }
  }

  /**
   * Run `step` after the one before it. Storing activity and taking a newly
   * seen transcript in each hand the other the sessions they could not
   * serve, so the two must not interleave: activity left alone a moment
   * before its transcript is taken in would otherwise wait for good.
   */
  private inOrder<T>(step: () => Promise<T>): Promise<T> {
    const run = this.steps.then(step, step)
    this.steps = run.catch(() => undefined)
    return run
  }

  /** Keep the later of what `activity` holds for the session and `activityAtMs`. */
  private keep(activity: Map<string, number>, sessionId: string, activityAtMs: number): void {
    activity.set(sessionId, Math.max(activity.get(sessionId) ?? -Infinity, activityAtMs))
  }

  /**
   * Bring the index in line with the transcripts directory, if the directory
   * changed since the last time, or may have (see {@link Reconciled.settled}).
   * Concurrent callers share one run.
   */
  private async reconcile(): Promise<void> {
    const arrivedAtMs = Date.now()
    for (;;) {
      const key = this.deps.key()
      const directoryMtimeMs = await this.directoryMtime()
      const last = this.reconciled?.key === key && this.reconciled.directoryMtimeMs === directoryMtimeMs ? this.reconciled : undefined
      if (last?.settled) return
      if (this.reconciling) {
        // Another reader's run. One that started after this reader arrived
        // saw everything this reader could expect to; an earlier one may
        // not have, so compare again with what this reader saw.
        const { run, startedAtMs } = this.reconciling
        await run
        if (startedAtMs >= arrivedAtMs) return
        continue
      }
      // The mtime was read before the listing, so a change in between is
      // seen as a change again by the next read.
      const startedAtMs = Date.now()
      const firstSeenAtMs = last?.firstSeenAtMs ?? startedAtMs
      const settled = directoryMtimeMs === null
        || startedAtMs - directoryMtimeMs > LONG_UNCHANGED_MS
        || startedAtMs - firstSeenAtMs >= (this.deps.directoryTickMs ?? DIRECTORY_TICK_MS)
      const lookAgainCalls = this.lookAgainCalls
      const run = this.reconcileWithDirectory(directoryMtimeMs !== null, last?.present)
        .then((present) => {
          if (this.lookAgainCalls === lookAgainCalls) this.reconciled = { key, directoryMtimeMs, firstSeenAtMs, settled, present }
        })
        .finally(() => {
          if (this.reconciling?.run === run) this.reconciling = undefined
        })
      this.reconciling = { run, startedAtMs }
      return run
    }
  }

  /**
   * Take in the transcripts the index has not seen and drop the entries of
   * those that are gone. Answers the transcripts the directory holds;
   * `lastPresent` is what it held when it was last listed with this mtime.
   */
  private async reconcileWithDirectory(directoryExists: boolean, lastPresent?: ReadonlySet<string>): Promise<ReadonlySet<string>> {
    // No directory is no evidence. An agent that never ran has none, and so
    // does a workspace whose volume is not mounted: taking that for "every
    // transcript was deleted" would drop every session's name with it.
    if (!directoryExists) return new Set()
    const { files } = this.deps
    const { storage } = this
    const present = new Set(await this.transcriptIds())
    // Nothing to take in, and nothing it can say is gone (see canConfirmGone).
    if (present.size === 0) return present
    // The same transcripts as the listing before: nothing came or went.
    if (lastPresent && lastPresent.size === present.size && [...present].every((sessionId) => lastPresent.has(sessionId))) return present
    const known = new Set<string>()
    for (const entry of await storage.list()) {
      if (entry.transcript) known.add(entry.sessionId)
    }
    const limit = pLimit(10)

    // Every stat is waited for: what the others found is stored before one
    // that failed fails the read, or the next read would stat them all again.
    const seen = await Promise.allSettled(
      [...present].filter((sessionId) => !known.has(sessionId)).map((sessionId) => limit(async () => {
        const stat = await this.statTranscript(sessionId)
        if (stat?.kind !== 'file') return null
        const transcript: TranscriptStat = { mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs ?? 0, size: stat.size }
        return { sessionId, meta: null, transcript }
      })),
    )
    const found = seen.flatMap((stat) => (stat.status === 'fulfilled' && stat.value ? [stat.value] : []))
    await this.inOrder(async () => {
      await storage.fill(found)
      for (const { sessionId } of found) {
        const awaited = this.awaitingTranscript.get(sessionId)
        if (awaited === undefined) continue
        this.awaitingTranscript.delete(sessionId)
        this.keep(this.pending, sessionId, awaited)
      }
    })
    const failed = seen.find((stat) => stat.status === 'rejected')
    if (failed) throw failed.reason

    // A listing that came back short must not cost a session its entry: each
    // transcript the listing lacks is confirmed gone by its own stat.
    const gone = await Promise.all(
      [...known].filter((sessionId) => !present.has(sessionId)).map((sessionId) => limit(async () =>
        (await files.stat(this.transcriptPath(sessionId))) === null ? sessionId : null,
      )),
    )
    await storage.delete(gone.filter((sessionId) => sessionId !== null))
    return present
  }

  private transcriptPath(sessionId: string): string {
    return joinWorkspacePath(this.deps.transcriptsDir, `${sessionId}.jsonl`)
  }

  private async directoryMtime(): Promise<number | null> {
    try {
      const stat = await this.deps.files.stat(this.deps.transcriptsDir)
      return stat?.kind === 'directory' ? stat.mtimeMs : null
    } catch {
      // Unreadable is treated as absent: nothing is learned from it.
      return null
    }
  }

  /**
   * The session ids of the `.jsonl` files directly in the transcripts
   * directory. The store never lists a link: a real transcript is a regular
   * file the container wrote, and a link named like a session is an escape
   * attempt (it resolves to another agent's transcript).
   */
  /**
   * Whether the transcripts directory can say that a session is gone: only
   * while it holds a transcript. No directory is no evidence, and neither is
   * an empty one: a volume that went away can leave an empty directory at
   * its path, and every name must still be there when it comes back. So
   * sessions that really were all removed by hand keep their entries until
   * a transcript is written again, or until they are deleted in the app.
   */
  async canConfirmGone(): Promise<boolean> {
    return (await this.transcriptIds()).length > 0
  }

  /** The ids of the transcripts in the directory; none when it is not there. */
  private async transcriptIds(): Promise<string[]> {
    let entries: Awaited<ReturnType<StoreFileOps['list']>>
    try {
      entries = await this.deps.files.list(this.deps.transcriptsDir)
    } catch (error) {
      // Not there, or gone since it was statted (the agent is being removed
      // while it is read).
      if (error instanceof WorkspaceFileError && error.code === 'not-found') return []
      throw error
    }
    return entries
      .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.slice(0, -'.jsonl'.length))
      .filter(isSessionIdWellFormed)
  }

  /**
   * Stat a transcript the index has not seen. A file deleted since the
   * listing answers null and is skipped. Anything else is retried once and
   * then fails the read: recording a transient network-filesystem failure
   * (ESTALE, EIO, a timeout) as "no such session" would hide the session
   * until the directory next changes.
   */
  private async statTranscript(sessionId: string) {
    const path = this.transcriptPath(sessionId)
    try {
      return await this.deps.files.stat(path)
    } catch {
      return this.deps.files.stat(path)
    }
  }
}
