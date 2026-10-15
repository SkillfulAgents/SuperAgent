import type { MeetingParticipant, MeetingParticipantEvent, MeetingRoster } from './schemas'

interface Room {
  participants: Map<string, MeetingParticipant>
  speaking: Set<string>
  listeners: Set<(roster: MeetingRoster) => void>
  /** Last event or subscription; idle rooms nobody watches are swept. */
  touchedAt: number
}

/**
 * A room nobody is watching that has heard nothing for this long is forgotten.
 * Rooms normally end with the meeting (`clear`); this catches a webhook that
 * arrives for a meeting the host no longer tracks (after a restart, or late),
 * which would otherwise create a room that lives until the process exits.
 */
export const MEETING_ROSTER_IDLE_TTL_MS = 4 * 60 * 60 * 1000

/**
 * Who is in each live meeting, as reported by the bot host. Held in memory:
 * the host replays nothing after a restart, and a roster only matters while
 * the call is on. The participant page streams it; the voice prompt reads it.
 */
export class MeetingRosterStore {
  private rooms = new Map<string, Room>()
  constructor(private readonly now: () => number = Date.now) {}

  get(meetingId: string): MeetingRoster {
    const room = this.rooms.get(meetingId)
    if (!room) return { participants: [], speaking: [] }
    return { participants: [...room.participants.values()], speaking: [...room.speaking] }
  }

  /** Apply a host event. The bot itself is not a participant; it is filtered by name. */
  apply(meetingId: string, event: MeetingParticipantEvent, botName: string): MeetingRoster {
    this.sweep()
    const room = this.room(meetingId)
    room.touchedAt = this.now()
    const { participant } = event
    if (participant.name.trim().toLowerCase() !== botName.trim().toLowerCase()) {
      switch (event.kind) {
        case 'join': case 'update': room.participants.set(participant.id, participant); break
        case 'leave': room.participants.delete(participant.id); room.speaking.delete(participant.id); break
        case 'speech_on': room.participants.set(participant.id, room.participants.get(participant.id) ?? participant); room.speaking.add(participant.id); break
        case 'speech_off': room.speaking.delete(participant.id); break
      }
    }
    const roster = this.get(meetingId)
    for (const listener of room.listeners) listener(roster)
    return roster
  }

  subscribe(meetingId: string, listener: (roster: MeetingRoster) => void): () => void {
    const room = this.room(meetingId)
    room.listeners.add(listener)
    room.touchedAt = this.now()
    return () => {
      room.listeners.delete(listener)
      room.touchedAt = this.now()
      if (room.listeners.size === 0 && room.participants.size === 0) this.rooms.delete(meetingId)
    }
  }

  /** The call is over: tell listeners the room is empty and forget it. */
  clear(meetingId: string): void {
    const room = this.rooms.get(meetingId)
    if (!room) return
    room.participants.clear()
    room.speaking.clear()
    for (const listener of room.listeners) listener({ participants: [], speaking: [] })
    this.rooms.delete(meetingId)
  }

  /** Rooms currently held, for tests and diagnostics. */
  size(): number { return this.rooms.size }

  private sweep(): void {
    const cutoff = this.now() - MEETING_ROSTER_IDLE_TTL_MS
    for (const [id, room] of this.rooms) {
      if (room.listeners.size === 0 && room.touchedAt < cutoff) this.rooms.delete(id)
    }
  }

  private room(meetingId: string): Room {
    let room = this.rooms.get(meetingId)
    if (!room) { room = { participants: new Map(), speaking: new Set(), listeners: new Set(), touchedAt: this.now() }; this.rooms.set(meetingId, room) }
    return room
  }
}

export const meetingRoster = new MeetingRosterStore()
