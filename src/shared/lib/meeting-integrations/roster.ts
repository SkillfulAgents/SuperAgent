import { z } from 'zod'
import { appState, defineNamespace, defineTopic, type Channel, type StateKey, type WriteOptions } from '../app-state'
import { background } from '../background'
import { storedMeetingRosterSchema, type MeetingParticipant, type MeetingParticipantEvent, type MeetingRoster, type StoredMeetingRoster } from './schemas'

/**
 * A roster nobody is watching that has heard nothing for this long is
 * forgotten. Rosters normally end with the meeting (`clear`); this catches a
 * webhook that arrives for a meeting the host no longer tracks (after a
 * restart, or late), which would otherwise leave a roster behind for good.
 */
export const MEETING_ROSTER_IDLE_TTL_MS = 4 * 60 * 60 * 1000
/**
 * How often a watcher restarts the roster's idle lifetime and reads it again.
 * Far inside the idle TTL, so a watched call stays live however quiet it is;
 * the read also catches up on a hint that was lost.
 */
export const MEETING_ROSTER_HEARTBEAT_MS = 5 * 60 * 1000
/**
 * How long the end of a call is remembered. Long past any callback that read
 * the meeting as live just before it ended, which would otherwise start a
 * fresh roster for a call that is over.
 */
export const MEETING_ROSTER_ENDED_TTL_MS = 60 * 60 * 1000
/**
 * Compare-and-set attempts before an update gives up. Each conflict means
 * another write landed, so only that many callbacks at once exhaust it; the
 * callback then fails with an error status, which hosts retry.
 */
const MAX_ROSTER_UPDATE_ATTEMPTS = 64

/** The bot is in the call as a participant too; it is told apart by its name. */
export function isMeetingBot(participant: Pick<MeetingParticipant, 'name'>, botName: string): boolean {
  return participant.name.trim().toLowerCase() === botName.trim().toLowerCase()
}

/**
 * Who is in each live meeting and who is talking, in AppState, so every
 * process serving the tenant sees one roster: the host's callbacks write it,
 * the participant page's stream and the voice prompt read it. Strong, because
 * callbacks arrive concurrently and each one is a compare-and-set.
 */
const meetingRosters = defineNamespace({
  name: 'meeting:roster',
  consistency: 'strong',
  schema: storedMeetingRosterSchema,
  // An idle lifetime: every change and every watcher heartbeat restarts it.
  expiry: { ttlMs: MEETING_ROSTER_IDLE_TTL_MS, onUpdate: 'reset' },
})

/** "Look again": names the change count of the roster that was just written. */
const meetingRosterHints = defineTopic({
  name: 'events:meeting:roster',
  schema: z.object({ revision: z.number().int().nonnegative() }),
})
type MeetingRosterHint = z.infer<typeof meetingRosterHints.schema>

/** The stored roster of one meeting, for tests and diagnostics. */
export function meetingRosterKey(meetingId: string): StateKey<StoredMeetingRoster, 'strong'> {
  return meetingRosters.key(meetingId)
}
/** Where a meeting's roster changes are announced, for tests and diagnostics. */
export function meetingRosterChannel(meetingId: string): Channel<MeetingRosterHint> {
  return meetingRosterHints.channel(meetingId)
}

const EMPTY_ROSTER: StoredMeetingRoster = { participantsById: {}, speakingIds: [], touchedAt: 0, revision: 0, ended: false }

function viewOf(roster: StoredMeetingRoster): MeetingRoster {
  return { participants: Object.values(roster.participantsById), speaking: [...roster.speakingIds] }
}

/** The roster after one host event, or null when the event changes nothing. The bot itself is never a participant. */
function reduce(roster: StoredMeetingRoster, event: MeetingParticipantEvent, botName: string): StoredMeetingRoster | null {
  if (roster.ended || isMeetingBot(event.participant, botName)) return null
  const { id, name, isHost } = event.participant
  const participant = { id, name, isHost }
  const participants = new Map(Object.entries(roster.participantsById))
  const speaking = new Set(roster.speakingIds)
  switch (event.kind) {
    case 'join': case 'update': participants.set(id, participant); break
    case 'leave': participants.delete(id); speaking.delete(id); break
    case 'speech_on': if (!participants.has(id)) participants.set(id, participant); speaking.add(id); break
    case 'speech_off': speaking.delete(id); break
  }
  const participantsById = Object.fromEntries(participants)
  const speakingIds = [...speaking]
  // A Map keeps the position of a key it already had, so an event that changed nothing serializes the same.
  if (JSON.stringify([participantsById, speakingIds]) === JSON.stringify([roster.participantsById, roster.speakingIds])) return null
  return { participantsById, speakingIds, touchedAt: Date.now(), revision: roster.revision + 1, ended: false }
}

/**
 * Applies `change` to what is stored and writes the result only while nothing
 * else has written since; after a conflict it applies `change` again to what
 * did. A written change is announced on the meeting's channel.
 */
async function update(meetingId: string, change: (roster: StoredMeetingRoster) => StoredMeetingRoster | null, options?: WriteOptions): Promise<void> {
  const key = meetingRosterKey(meetingId)
  let current = await appState().get(key)
  for (let attempt = 0; attempt < MAX_ROSTER_UPDATE_ATTEMPTS; attempt++) {
    const next = change(current?.value ?? EMPTY_ROSTER)
    if (!next) return
    const written = await appState().compareAndSet(key, current?.revision ?? null, next, options)
    if (written.ok) {
      await appState().publish(meetingRosterChannel(meetingId), { revision: next.revision })
      return
    }
    current = written.current
  }
  throw new Error(`The roster of meeting ${meetingId} changed under ${MAX_ROSTER_UPDATE_ATTEMPTS} updates in a row`)
}

/** Writes the roster back as it is, which restarts its idle lifetime. A conflict means another write just restarted it. */
async function touch(key: StateKey<StoredMeetingRoster, 'strong'>): Promise<void> {
  const entry = await appState().get(key)
  if (!entry || entry.value.ended) return
  await appState().compareAndSet(key, entry.revision, { ...entry.value, touchedAt: Date.now() }, { expiry: 'reset' })
}

export interface MeetingRosterWatch {
  /** Once this resolves, `onRoster` is not called again and the heartbeat has stopped. Idempotent. */
  stop(): Promise<void>
}

/**
 * Who is in each live meeting, as reported by the bot host. The roster lives
 * in AppState (see `meetingRosters`); the host replays nothing after a
 * restart, and a roster only matters while the call is on.
 */
export const meetingRoster = {
  async get(meetingId: string): Promise<MeetingRoster> {
    return viewOf((await appState().get(meetingRosterKey(meetingId)))?.value ?? EMPTY_ROSTER)
  },

  /** Apply a host event. The bot itself is not a participant; it is filtered by name. A call that has ended takes no more. */
  async apply(meetingId: string, event: MeetingParticipantEvent, botName: string): Promise<void> {
    await update(meetingId, roster => reduce(roster, event, botName))
  },

  /**
   * The call is over: the roster becomes empty and ended, so a callback that
   * was already on its way cannot start it again. The ended roster is kept
   * for `MEETING_ROSTER_ENDED_TTL_MS`, then forgotten like any other.
   */
  async clear(meetingId: string): Promise<void> {
    await update(
      meetingId,
      roster => roster.ended ? null : { participantsById: {}, speakingIds: [], touchedAt: Date.now(), revision: roster.revision + 1, ended: true },
      { expiry: { ttlMs: MEETING_ROSTER_ENDED_TTL_MS } },
    )
  },

  /**
   * Follow a meeting's roster: `onRoster` gets the current one before this
   * resolves, then each change. While it runs, a heartbeat keeps the roster
   * from expiring, so a quiet call that someone watches stays live; once the
   * last watcher stops, the four-hour idle lifetime runs from the last
   * heartbeat or change. The timer is this process's, so call `stop`.
   */
  async watch(meetingId: string, onRoster: (roster: MeetingRoster) => void): Promise<MeetingRosterWatch> {
    const key = meetingRosterKey(meetingId)
    let stopped = false
    // The change count of the roster last handed over; null before the first.
    let shown: number | null = null
    let reading: Promise<void> | null = null
    let readAgain = false
    const read = async () => {
      const roster = (await appState().get(key))?.value ?? EMPTY_ROSTER
      if (stopped || roster.revision === shown) return
      shown = roster.revision
      onRoster(viewOf(roster))
    }
    // One read at a time, and one more when asked during it. Reads are
    // strong, so each one sees at least what the one before it did: a hint
    // that raced a read is read again after it, never instead of it.
    const refresh = (): Promise<void> => {
      if (reading) { readAgain = true; return reading }
      reading = (async () => {
        try { do { readAgain = false; await read() } while (readAgain && !stopped) }
        finally { reading = null }
      })()
      return reading
    }
    // Subscribed before the first read, so a change made while it runs is heard.
    // A hint for the roster already shown is dropped; any other one is read
    // again rather than ordered, since a roster that expired and came back
    // counts its changes from zero.
    const subscription = await appState().subscribe([meetingRosterChannel(meetingId)], hint => hint.revision === shown ? undefined : refresh())
    const heartbeat = setInterval(() => background(async () => { await touch(key); await refresh() }, { name: 'meeting-roster.heartbeat' }), MEETING_ROSTER_HEARTBEAT_MS)
    const stop = async () => {
      stopped = true
      clearInterval(heartbeat)
      await subscription.unsubscribe()
    }
    try {
      // A roster close to its idle expiry gets a full lifetime before the first heartbeat.
      await touch(key)
      await refresh()
    } catch (error) {
      await stop()
      throw error
    }
    return { stop }
  },
}
