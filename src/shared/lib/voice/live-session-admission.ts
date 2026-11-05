/**
 * Who may hold a Live voice session: at most four per user, counting the ones
 * a provider is still creating, across every process that serves the tenant.
 *
 * One strong AppState record per user lists the user's sessions. Each
 * transition is one conditional write decided from what the record holds
 * (`reduceRecord`), so two processes cannot both fill a user's last place,
 * and a late write cannot undo a newer one. Each transition also
 * drops the entries that are past keeping.
 *
 * An entry is a reservation first (`pending`, while the provider creates the
 * session), then `active`, then `closing` once a release asked the provider to
 * hang it up. It holds the creating provider's id and, once created, the
 * provider's session id: what any process needs to hang it up. It holds no
 * key; a hangup uses that provider's key as configured at the time.
 *
 * Expiry is when an entry stops counting, not a hangup: nothing here calls a
 * provider. The process that created a session hangs it up at its deadline
 * (`live-session-registry.ts`); a session whose process is gone stops counting
 * at its deadline, and nobody hangs it up.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appState, defineNamespace, reduceRecord, type RecordChange, type StateKey } from '../app-state'
import { VOICE_PROVIDERS, type VoiceProvider } from './provider-types'

/** Pending and active sessions a user may hold at once. */
export const LIVE_SESSION_LIMIT = 4
/** How long a session lasts from its creation. */
export const LIVE_SESSION_MAX_MS = 60 * 60 * 1000
/**
 * How long a reservation counts without being renewed. The process creating
 * the session renews it while the provider works, so only a reservation whose
 * process is gone runs out.
 */
export const LIVE_SESSION_PENDING_LEASE_MS = 2 * 60 * 1000
/**
 * How long an entry is kept past its `expiresAt`. The deadline's hangup looks
 * the session up then, to tell one that was hung up elsewhere (removed)
 * from one that still needs it.
 */
export const LIVE_SESSION_RETAIN_MS = 5 * 60 * 1000
/**
 * Entries one record holds, closing ones included. A user whose hangups keep
 * failing is refused new sessions here rather than growing the record.
 */
export const LIVE_SESSION_RECORD_MAX = 32

const entryFields = {
  /** The reservation's id, and the session's handle once it is active. */
  id: z.uuid(),
  provider: z.enum(VOICE_PROVIDERS),
  /**
   * Epoch ms, from the clock of the process that wrote it. Pending: the end of
   * the lease. Active and closing: the session's deadline.
   */
  expiresAt: z.number().int(),
}
const providerSessionId = z.string().min(1).max(512)

const liveSessionEntrySchema = z.discriminatedUnion('state', [
  z.object({ ...entryFields, state: z.literal('pending') }),
  z.object({ ...entryFields, state: z.literal('active'), providerSessionId }),
  z.object({ ...entryFields, state: z.literal('closing'), providerSessionId }),
])
export type LiveSessionEntry = z.infer<typeof liveSessionEntrySchema>
export type CreatedLiveSessionEntry = Extract<LiveSessionEntry, { state: 'active' | 'closing' }>

const liveSessionRecordSchema = z.object({
  sessions: z.array(liveSessionEntrySchema).min(1).max(LIVE_SESSION_RECORD_MAX)
    .refine(sessions => new Set(sessions.map(session => session.id)).size === sessions.length, 'Live session ids are unique'),
})
export type LiveSessionRecord = z.infer<typeof liveSessionRecordSchema>

/** The ticket's `voice:owner:{userId}:sessions`: one record per user. */
const liveSessionRecords = defineNamespace({
  name: 'voice:owner:sessions',
  consistency: 'strong',
  schema: liveSessionRecordSchema,
  // Every write sets the record's expiry to when its last entry is past
  // keeping (`write`); this only bounds a record written some other way.
  expiry: { ttlMs: LIVE_SESSION_MAX_MS + LIVE_SESSION_RETAIN_MS, onUpdate: 'reset' },
})

/** A user's record, for tests and diagnostics. Only this module writes it. */
export function liveSessionsKey(owner: string): StateKey<LiveSessionRecord, 'strong'> {
  return liveSessionRecords.key(owner)
}

/** The entries still kept at `now`; the rest are dropped by the next write. */
function kept(record: LiveSessionRecord | null, now: number): LiveSessionEntry[] {
  return (record?.sessions ?? []).filter(session => now < session.expiresAt + LIVE_SESSION_RETAIN_MS)
}

/** Whether an entry takes one of the user's four places at `now`. */
function counts(session: LiveSessionEntry, now: number): boolean {
  return session.state !== 'closing' && now < session.expiresAt
}

/** Writes `sessions` as the record, kept until its last entry is past keeping; deletes it when empty. */
function write<R>(sessions: LiveSessionEntry[], result: R): RecordChange<LiveSessionRecord, R> {
  if (sessions.length === 0) return { result, value: null }
  const keepUntil = Math.max(...sessions.map(session => session.expiresAt)) + LIVE_SESSION_RETAIN_MS
  return { result, value: { sessions }, expiry: { at: keepUntil } }
}

/** Replaces the entry with `id` by `next` (or drops it, for null), keeping the others as they are. */
function replace<R>(sessions: LiveSessionEntry[], id: string, next: LiveSessionEntry | null, result: R): RecordChange<LiveSessionRecord, R> {
  return write(sessions.flatMap(session => session.id !== id ? [session] : next ? [next] : []), result)
}

/** The user's sessions that take a place now: pending and active ones. */
export async function countLiveSessions(owner: string): Promise<number> {
  const record = await appState().get(liveSessionsKey(owner))
  const now = Date.now()
  return kept(record?.value ?? null, now).filter(session => counts(session, now)).length
}

/**
 * Admits one more session for `owner` when fewer than four are pending or
 * active, as one conditional write: a reservation that counts until its lease
 * runs out. Null when the user has no place left.
 */
export async function reserveLiveSession(owner: string, provider: VoiceProvider): Promise<{ id: string; expiresAt: number } | null> {
  const id = randomUUID()
  return await reduceRecord(liveSessionsKey(owner), (record) => {
    const now = Date.now()
    const sessions = kept(record, now)
    if (sessions.filter(session => counts(session, now)).length >= LIVE_SESSION_LIMIT) return { result: null }
    if (sessions.length >= LIVE_SESSION_RECORD_MAX) return { result: null }
    const reservation: LiveSessionEntry = { id, state: 'pending', provider, expiresAt: now + LIVE_SESSION_PENDING_LEASE_MS }
    return write([...sessions, reservation], { id, expiresAt: reservation.expiresAt })
  })
}

/**
 * Restarts a reservation's lease while the provider is still creating the
 * session. False once the reservation is gone, started, or ran out: a lease
 * that ran out is not renewed, since its place may already be taken.
 */
export async function renewLiveSessionReservation(owner: string, id: string): Promise<boolean> {
  return await reduceRecord(liveSessionsKey(owner), (record) => {
    const now = Date.now()
    const sessions = kept(record, now)
    const session = sessions.find(candidate => candidate.id === id)
    if (session?.state !== 'pending' || now >= session.expiresAt) return { result: false }
    return replace(sessions, id, { ...session, expiresAt: now + LIVE_SESSION_PENDING_LEASE_MS }, true)
  })
}

/** Frees a reservation whose session never started. Leaves the entry alone once it is active. */
export async function cancelLiveSessionReservation(owner: string, id: string): Promise<void> {
  await reduceRecord(liveSessionsKey(owner), (record) => {
    const sessions = kept(record, Date.now())
    if (sessions.find(session => session.id === id)?.state !== 'pending') return { result: undefined }
    return replace(sessions, id, null, undefined)
  })
}

/**
 * The provider created the session: the reservation becomes the active
 * session, until its deadline an hour from now. Null when the reservation is
 * no longer pending (cancelled, or its lease ran out): it is not recreated,
 * and the caller hangs up the session it just created.
 */
export async function activateLiveSession(owner: string, id: string, providerSessionId: string): Promise<{ expiresAt: number } | null> {
  return await reduceRecord(liveSessionsKey(owner), (record) => {
    const now = Date.now()
    const sessions = kept(record, now)
    const session = sessions.find(candidate => candidate.id === id)
    if (session?.state !== 'pending' || now >= session.expiresAt) return { result: null }
    const expiresAt = now + LIVE_SESSION_MAX_MS
    return replace(sessions, id, { id, state: 'active', provider: session.provider, providerSessionId, expiresAt }, { expiresAt })
  })
}

/**
 * Marks an active session closing, so it no longer counts, and returns what a
 * hangup needs. A session already closing is returned as it is, for another
 * attempt. Null when there is no such session: never created, or hung up and
 * removed already. A session past its deadline is still found while it is
 * kept, so its hangup can still be made.
 */
export async function closeLiveSessionEntry(owner: string, id: string): Promise<CreatedLiveSessionEntry | null> {
  return await reduceRecord(liveSessionsKey(owner), (record): RecordChange<LiveSessionRecord, CreatedLiveSessionEntry | null> => {
    const sessions = kept(record, Date.now())
    const session = sessions.find(candidate => candidate.id === id)
    if (!session || session.state === 'pending') return { result: null }
    if (session.state === 'closing') return { result: session }
    const closing: CreatedLiveSessionEntry = { ...session, state: 'closing' }
    return replace(sessions, id, closing, closing)
  })
}

/**
 * Removes a closing session once its hangup is done (or given up at its
 * deadline). Only that entry, and only while it is closing: nothing else in
 * the record changes, whatever was written since the hangup began.
 */
export async function removeClosedLiveSession(owner: string, id: string): Promise<void> {
  await reduceRecord(liveSessionsKey(owner), (record) => {
    const sessions = kept(record, Date.now())
    if (sessions.find(session => session.id === id)?.state !== 'closing') return { result: undefined }
    return replace(sessions, id, null, undefined)
  })
}
