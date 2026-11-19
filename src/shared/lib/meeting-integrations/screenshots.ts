import { PNG } from 'pngjs'
import { agentRegistry } from '../agent-actor'
import type { FileOps } from '../agent-actor/types'
import { background } from '../background'
import { captureException } from '../error-reporting'
import { voiceTranscriptDirectory } from '../voice/transcripts'
import type { MeetingScreenFrame } from './schemas'

/** Screen-share screenshots live beside the session's voice transcripts. */
export function meetingScreenshotsDir(sessionId: string): string {
  return `${voiceTranscriptDirectory(sessionId)}/screenshots/`
}

/** `HH-MM-SS.png` in UTC, the same clock as the transcript lines. */
export function screenshotFileName(at: Date): string {
  return `${at.toISOString().slice(11, 19).replace(/:/g, '-')}.png`
}

/** A changed screen is compared at most this often; a share sends several frames a second. */
export const SCREENSHOT_CHECK_MS = 1000
/** At most one screenshot per this interval, so scrolling or a video does not fill the folder. */
export const SCREENSHOT_MIN_GAP_MS = 5000
/** One meeting keeps at most this many (about 150 KB each). */
export const SCREENSHOTS_PER_MEETING_MAX = 500

const THUMB_WIDTH = 64
const THUMB_HEIGHT = 36
/** A thumbnail pixel counts as changed above this brightness step (0–255). */
const PIXEL_CHANGE = 16
/**
 * Saved when more than this share of thumbnail pixels changed. Measured on a
 * live Zoom share: a still screen moved 0.0%, a slide or window change 2.7–11%.
 */
const SCREEN_CHANGE_RATIO = 0.01

/** The frame shrunk to a small grayscale grid: enough to see a slide change, blind to compression noise. */
export function screenThumbnail(png: Uint8Array): Uint8Array {
  const image = PNG.sync.read(Buffer.from(png))
  const thumb = new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT)
  for (let ty = 0; ty < THUMB_HEIGHT; ty++) {
    const y0 = Math.floor((ty * image.height) / THUMB_HEIGHT)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * image.height) / THUMB_HEIGHT))
    for (let tx = 0; tx < THUMB_WIDTH; tx++) {
      const x0 = Math.floor((tx * image.width) / THUMB_WIDTH)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * image.width) / THUMB_WIDTH))
      let sum = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * image.width + x) * 4
          sum += 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2]
        }
      }
      thumb[ty * THUMB_WIDTH + tx] = Math.round(sum / ((y1 - y0) * (x1 - x0)))
    }
  }
  return thumb
}

export function screenChanged(previous: Uint8Array, next: Uint8Array): boolean {
  let changed = 0
  for (let i = 0; i < next.length; i++) if (Math.abs(next[i] - previous[i]) > PIXEL_CHANGE) changed++
  return changed > next.length * SCREEN_CHANGE_RATIO
}

interface Room {
  agentSlug: string
  sessionId: string
  saved: number
  lastSavedAt: number
  lastCheckedAt: number
  thumbnail: Uint8Array | null
  busy: boolean
}

/**
 * Screenshots of what people share in each meeting, kept as files in the
 * agent's workspace. Frames arrive several times a second; a frame is saved
 * only when the screen visibly changed since the last saved one, and frames
 * that arrive while one is being checked or written are dropped.
 */
export class MeetingScreenshotStore {
  private rooms = new Map<string, Room>()
  constructor(
    private readonly filesFor: (agentSlug: string) => FileOps = agentSlug => agentRegistry.get(agentSlug).files,
    private readonly now: () => number = Date.now,
  ) {}

  offer(meeting: { id: string; agentSlug: string; sessionId: string }, frame: MeetingScreenFrame): void {
    let room = this.rooms.get(meeting.id)
    if (!room || room.sessionId !== meeting.sessionId) {
      room = { agentSlug: meeting.agentSlug, sessionId: meeting.sessionId, saved: 0, lastSavedAt: -Infinity, lastCheckedAt: -Infinity, thumbnail: null, busy: false }
      this.rooms.set(meeting.id, room)
    }
    const now = this.now()
    if (room.busy || room.saved >= SCREENSHOTS_PER_MEETING_MAX) return
    if (now - room.lastSavedAt < SCREENSHOT_MIN_GAP_MS || now - room.lastCheckedAt < SCREENSHOT_CHECK_MS) return
    room.busy = true
    room.lastCheckedAt = now
    background(this.consider(meeting.id, room, frame).finally(() => { room.busy = false }), { name: 'meeting-screenshots.consider' })
  }

  /** The call is over: forget the meeting. */
  close(meetingId: string): void {
    this.rooms.delete(meetingId)
  }

  private async consider(meetingId: string, room: Room, frame: MeetingScreenFrame): Promise<void> {
    try {
      const thumbnail = screenThumbnail(frame.png)
      if (room.thumbnail && !screenChanged(room.thumbnail, thumbnail)) return
      await this.filesFor(room.agentSlug).putDoc(`${meetingScreenshotsDir(room.sessionId)}${screenshotFileName(frame.at)}`, frame.png)
      room.thumbnail = thumbnail
      room.saved++
      room.lastSavedAt = this.now()
    } catch (error) {
      captureException(error, { tags: { component: 'meeting-integration', operation: 'write-screenshot' }, extra: { meetingId } })
    }
  }

  /** Meetings with state in memory, for tests and diagnostics. */
  size(): number { return this.rooms.size }
}

export const meetingScreenshots = new MeetingScreenshotStore()
