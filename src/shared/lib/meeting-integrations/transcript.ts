import { agentRegistry } from '../agent-actor'
import type { FileOps } from '../agent-actor/types'
import { background } from '../background'
import { captureException } from '../error-reporting'
import type { MeetingTranscriptLine } from './schemas'

/** The live transcript of one meeting, in its agent's workspace. */
export function meetingTranscriptPath(meetingId: string): string {
  return `/workspace/meetings/${meetingId}/transcript.md`
}

/** How long speech waits before it is written: the file runs about this far behind the call. */
export const MEETING_TRANSCRIPT_FLUSH_MS = 3000
/** A pause this long in someone's speech ends their line. */
const TRANSCRIPT_PAUSE_MS = 2000
/** A line is cut after this long, so a long talk is written in pieces while it goes on. */
const TRANSCRIPT_LINE_MAX_MS = 20_000
/** The name on room speech heard before anyone was reported to start talking. */
const UNKNOWN_SPEAKER = 'Unknown participant'
/** Recent changes of speaker kept per meeting; speech is placed within seconds of arriving. */
const SPEAKER_CHANGES_KEPT = 64

/** One line per stretch of speech, `[HH:MM:SS] Speaker: words` in UTC. Whitespace is folded so speech cannot start a line of its own. */
export function formatTranscriptLine(line: MeetingTranscriptLine, at: Date): string {
  const fold = (value: string) => value.replace(/\s+/g, ' ').trim()
  return `[${at.toISOString().slice(11, 19)}] ${fold(line.speaker)}: ${fold(line.text)}\n`
}

interface OpenLine { speaker: string; text: string; startedAt: number; lastAt: number }

/** A piece of the call's speech; `speaker` is set when the source already knows who said it (the bot itself). */
export interface SpeechPiece { text: string; at: number; speaker?: string }

interface Room {
  agentSlug: string
  /** Speech not yet placed on a line, oldest first. */
  speech: SpeechPiece[]
  /** Who started talking when, oldest first. */
  speakers: Array<{ at: number; name: string }>
  /** The line still growing. */
  open: OpenLine | null
  /** Finished lines waiting for the next write. */
  pending: string[]
  timer: ReturnType<typeof setTimeout> | null
  writing: Promise<void>
}

function speakerAt(speakers: Room['speakers'], at: number): string {
  for (let i = speakers.length - 1; i >= 0; i--) if (speakers[i].at <= at) return speakers[i].name
  return UNKNOWN_SPEAKER
}

/**
 * The live transcript of each meeting, kept as a file in the agent's
 * workspace. The bot's voice engine reports the call's speech as it
 * transcribes it, its own lines already named, and the bot host reports who
 * starts talking. Every few seconds each piece of room speech goes to whoever
 * last started talking before it was heard, and the pieces are grouped into
 * lines: a line ends when the speaker changes, after a pause, or when it
 * grows long. Placing speech only at the write leaves time for a speaker
 * change that arrives just after the words it explains.
 * Each write reads the file back first, so after a host restart in the
 * middle of a call the file keeps what was written and only speech still in
 * memory is lost.
 */
export class MeetingTranscriptStore {
  private rooms = new Map<string, Room>()
  constructor(
    private readonly filesFor: (agentSlug: string) => FileOps = agentSlug => agentRegistry.get(agentSlug).files,
    private readonly flushMs = MEETING_TRANSCRIPT_FLUSH_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Someone started talking: speech heard from then on is theirs until someone else starts. */
  speakerStarted(meeting: { id: string; agentSlug: string }, name: string, at = this.now()): void {
    const room = this.room(meeting)
    room.speakers.push({ at, name })
    if (room.speakers.length > SPEAKER_CHANGES_KEPT) room.speakers.shift()
  }

  /** A piece of the call's speech as the voice engine transcribed it, with when it was heard on this host's clock. */
  append(meeting: { id: string; agentSlug: string }, piece: SpeechPiece): void {
    const room = this.room(meeting)
    room.speech.push(piece)
    this.schedule(meeting.id, room)
  }

  /** The call is over: write all speech still waiting and forget the meeting. */
  async close(meetingId: string): Promise<void> {
    const room = this.rooms.get(meetingId)
    if (!room) return
    if (room.timer) clearTimeout(room.timer)
    room.timer = null
    this.rooms.delete(meetingId)
    this.place(room, true)
    await this.write(meetingId, room)
  }

  /** Meetings held in memory, for tests and diagnostics. */
  size(): number { return this.rooms.size }

  private room(meeting: { id: string; agentSlug: string }): Room {
    let room = this.rooms.get(meeting.id)
    if (!room) {
      room = { agentSlug: meeting.agentSlug, speech: [], speakers: [], open: null, pending: [], timer: null, writing: Promise.resolve() }
      this.rooms.set(meeting.id, room)
    }
    return room
  }

  private schedule(meetingId: string, room: Room): void {
    room.timer ??= setTimeout(() => {
      room.timer = null
      this.place(room, false)
      background(this.write(meetingId, room), { name: 'meeting-transcript.flush' })
      // A line still growing is finished by a later write once its speaker pauses.
      if (room.open) this.schedule(meetingId, room)
    }, this.flushMs)
  }

  private place(room: Room, final: boolean): void {
    for (const piece of room.speech.splice(0)) {
      const speaker = piece.speaker ?? speakerAt(room.speakers, piece.at)
      const line = room.open
      if (line && line.speaker === speaker && piece.at - line.lastAt < TRANSCRIPT_PAUSE_MS && piece.at - line.startedAt < TRANSCRIPT_LINE_MAX_MS) {
        line.text += piece.text
        line.lastAt = piece.at
      } else {
        this.finish(room)
        room.open = { speaker, text: piece.text, startedAt: piece.at, lastAt: piece.at }
      }
    }
    if (room.open && (final || this.now() - room.open.lastAt >= TRANSCRIPT_PAUSE_MS)) this.finish(room)
  }

  private finish(room: Room): void {
    const line = room.open
    room.open = null
    if (line?.text.trim()) room.pending.push(formatTranscriptLine({ speaker: line.speaker, text: line.text }, new Date(line.startedAt)))
  }

  private write(meetingId: string, room: Room): Promise<void> {
    room.writing = room.writing.then(async () => {
      const lines = room.pending.splice(0)
      if (lines.length === 0) return
      const path = meetingTranscriptPath(meetingId)
      try {
        const files = this.filesFor(room.agentSlug)
        const existing = await files.getDoc(path)
        await files.putDoc(path, (existing ? new TextDecoder().decode(existing) : '') + lines.join(''))
      } catch (error) {
        captureException(error, { tags: { component: 'meeting-integration', operation: 'write-transcript' }, extra: { meetingId, lines: lines.length } })
      }
    })
    return room.writing
  }
}

export const meetingTranscripts = new MeetingTranscriptStore()
