import { agentRegistry } from '../agent-actor'
import type { FileOps } from '../agent-actor/types'
import { background } from '../background'
import { captureException } from '../error-reporting'
import type { MeetingTranscriptLine } from './schemas'

/** The live transcript of one meeting, in its agent's workspace. */
export function meetingTranscriptPath(meetingId: string): string {
  return `/workspace/meetings/${meetingId}/transcript.md`
}

/** How long new lines wait before they are written: the file runs at most this far behind the call. */
export const MEETING_TRANSCRIPT_FLUSH_MS = 3000

/** One line per utterance, `[HH:MM:SS] Speaker: words` in UTC. Whitespace is folded so speech cannot start a line of its own. */
export function formatTranscriptLine(line: MeetingTranscriptLine, at: Date): string {
  const fold = (value: string) => value.replace(/\s+/g, ' ').trim()
  return `[${at.toISOString().slice(11, 19)}] ${fold(line.speaker)}: ${fold(line.text)}\n`
}

interface Room {
  agentSlug: string
  pending: string[]
  timer: ReturnType<typeof setTimeout> | null
  writing: Promise<void>
}

/**
 * The live transcript of each meeting, kept as a file in the agent's
 * workspace. Lines are batched and appended every few seconds. Each write
 * reads the file back first, so after a host restart in the middle of a call
 * the file keeps what was written and only the lines still waiting are lost.
 */
export class MeetingTranscriptStore {
  private rooms = new Map<string, Room>()
  constructor(
    private readonly filesFor: (agentSlug: string) => FileOps = agentSlug => agentRegistry.get(agentSlug).files,
    private readonly flushMs = MEETING_TRANSCRIPT_FLUSH_MS,
  ) {}

  append(meeting: { id: string; agentSlug: string }, line: MeetingTranscriptLine, at = new Date()): void {
    let room = this.rooms.get(meeting.id)
    if (!room) { room = { agentSlug: meeting.agentSlug, pending: [], timer: null, writing: Promise.resolve() }; this.rooms.set(meeting.id, room) }
    room.pending.push(formatTranscriptLine(line, at))
    room.timer ??= setTimeout(() => {
      room.timer = null
      background(this.write(meeting.id, room), { name: 'meeting-transcript.flush' })
    }, this.flushMs)
  }

  /** The call is over: write what is waiting and forget the meeting. */
  async close(meetingId: string): Promise<void> {
    const room = this.rooms.get(meetingId)
    if (!room) return
    if (room.timer) clearTimeout(room.timer)
    room.timer = null
    this.rooms.delete(meetingId)
    await this.write(meetingId, room)
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

  /** Meetings with lines in memory, for tests and diagnostics. */
  size(): number { return this.rooms.size }
}

export const meetingTranscripts = new MeetingTranscriptStore()
