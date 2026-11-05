import { meetingSpeakerChangesSchema, type MeetingSpeakerChanges } from './transcript-speakers-schema'
import { appState, defineNamespace, type StateKey } from '../app-state'
import { getIntegrationSessionBySessionId } from '../agent-integrations/store'
import type { NamedVoiceSpeech } from '../voice/transcripts'
import { getMeeting } from './store'

/** Recent changes of speaker kept per meeting; speech is placed within seconds of arriving. */
const SPEAKER_CHANGES_KEPT = 64
/** Speaker changes nobody added to for this long are forgotten; a meeting lasts at most a few hours. */
const SPEAKERS_IDLE_TTL_MS = 4 * 60 * 60 * 1000
/** Compare-and-set attempts before a speaker change gives up; the host's callback then fails and is retried. */
const MAX_SPEAKER_UPDATE_ATTEMPTS = 64


/**
 * Who started talking when, per meeting, in AppState: the host's callbacks
 * and the page's speech can reach different processes, and every one of them
 * must name speech the same way.
 */
const meetingSpeakers = defineNamespace({
  name: 'meeting:transcript-speakers',
  consistency: 'strong',
  schema: meetingSpeakerChangesSchema,
  expiry: { ttlMs: SPEAKERS_IDLE_TTL_MS, onUpdate: 'reset' },
})

/** A meeting's stored speaker changes, for tests and diagnostics. */
export function meetingSpeakersKey(meetingId: string): StateKey<MeetingSpeakerChanges, 'strong'> {
  return meetingSpeakers.key(meetingId)
}

export async function meetingSpeakerStarted(meetingId: string, name: string, at = Date.now()): Promise<void> {
  const key = meetingSpeakersKey(meetingId)
  let current = await appState().get(key)
  for (let attempt = 0; attempt < MAX_SPEAKER_UPDATE_ATTEMPTS; attempt++) {
    const next = [...(current?.value ?? []), { at, name }].sort((a, b) => a.at - b.at).slice(-SPEAKER_CHANGES_KEPT)
    const written = await appState().compareAndSet(key, current?.revision ?? null, next)
    if (written.ok) return
    current = written.current
  }
  throw new Error(`The speakers of meeting ${meetingId} changed too often to record`)
}

/** Optional meeting enrichment of a generic voice transcript, resolved from the authorized session. */
export async function nameMeetingVoiceSpeech(agentSlug: string, sessionId: string, pieces: readonly NamedVoiceSpeech[]): Promise<readonly NamedVoiceSpeech[]> {
  const session = await getIntegrationSessionBySessionId(agentSlug, sessionId)
  const meeting = session ? await getMeeting(session.externalId) : null
  if (!meeting || meeting.agentSlug !== agentSlug || meeting.integrationId !== session?.integrationId) {
    return pieces
  }
  const speakers = (await appState().get(meetingSpeakersKey(meeting.id)))?.value ?? []
  return pieces.map(piece => ({ ...piece, speaker: piece.role === 'assistant' ? meeting.botName
    : speakers.findLast(speaker => speaker.at <= piece.at)?.name ?? 'Unknown participant' }))
}
