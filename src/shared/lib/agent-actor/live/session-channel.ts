/**
 * A session's own event stream: what the session's viewers (the app's
 * session view, chat integrations) hear as the session runs. Each listener
 * gets every event, in order, before `emit` returns; a listener that throws
 * reaches neither the emitter nor the other listeners.
 *
 * Two kinds of listener:
 * - `listen`: the bare events, for the app's own consumers;
 * - `follow`: wire frames, for a viewer's stream. Every event a frame can
 *   carry (it serializes) is numbered within the channel's epoch (a random id
 *   minted with the channel), so a frame id `${epoch}:${seq}` names one event
 *   of one channel.
 *
 * While the channel keeps frames for replay (`keepForReplay`), the last ones
 * stay in a bounded buffer: a viewer that comes back with the id of the last
 * frame it got is given what it missed (`framesAfter`), as long as the buffer
 * still reaches back that far.
 */
import { randomUUID } from 'crypto'

export interface SessionEvent {
  type: string
  [key: string]: unknown
}

export type SessionListener = (event: SessionEvent) => void

/** One frame on a viewer's wire. A snapshot frame that stands for no single event carries no id. */
export interface WireFrame {
  /** `${epoch}:${seq}`: what a viewer that got this frame resumes after. */
  readonly id?: string
  /** The event as JSON, serialized once for every viewer. */
  readonly data: string
}

export type FrameListener = (frame: WireFrame) => void

/** How much of the recent past a channel keeps for viewers that come back. */
export interface ReplayLimits {
  readonly maxFrames: number
  readonly maxBytes: number
}

// A reconnect comes back within seconds; this covers a long burst of
// streaming in between (tool inputs stream as their whole text so far, so
// the byte bound is the one that usually applies).
export const DEFAULT_REPLAY_LIMITS: ReplayLimits = { maxFrames: 2000, maxBytes: 4 * 1024 * 1024 }

interface KeptFrame extends WireFrame {
  readonly id: string
  /** Frames with the same key replace each other: only the last one of a run is worth replaying. */
  readonly supersedes?: string
}

const frameId = (epoch: string, seq: number) => `${epoch}:${seq}`

// A tool's streaming input carries its whole text so far, the main agent's
// and a subagent's alike.
function supersedesKey(event: SessionEvent): string | undefined {
  if (typeof event.toolId !== 'string') return undefined
  if (event.type === 'tool_use_streaming') return `${event.type}:${event.toolId}`
  if (event.type === 'subagent_tool_use_streaming') return `${event.type}:${String(event.parentToolId)}:${event.toolId}`
  return undefined
}

export class SessionChannel {
  readonly epoch: string
  private seq = 0
  private keeping = false
  private readonly kept: KeptFrame[] = []
  private keptBytes = 0
  private readonly listeners = new Set<SessionListener>()
  private readonly followers = new Set<FrameListener>()

  constructor(private readonly limits: ReplayLimits = DEFAULT_REPLAY_LIMITS, epoch: string = randomUUID().slice(0, 8)) {
    this.epoch = epoch
  }

  get listenerCount(): number {
    return this.listeners.size + this.followers.size
  }

  get followerCount(): number {
    return this.followers.size
  }

  /** The id of the last frame: what a snapshot of the session taken now stands for. */
  get lastId(): string {
    return frameId(this.epoch, this.seq)
  }

  emit(event: SessionEvent): void {
    for (const listener of this.listeners) deliver(listener, event)
    let data: string
    try {
      data = JSON.stringify(event)
    } catch (error) {
      console.error(`[SessionChannel] An event that cannot be serialized stays off the wire (${event.type}):`, error)
      return
    }
    this.seq += 1
    const frame: KeptFrame = { id: frameId(this.epoch, this.seq), data, supersedes: supersedesKey(event) }
    if (this.keeping) this.keep(frame)
    const wire: WireFrame = { id: frame.id, data }
    for (const follower of this.followers) deliver(follower, wire)
  }

  /**
   * Keep frames for viewers that come back, or stop and drop what is kept.
   * Only a viewer on the wire can come back for them, so the app's own
   * listeners never pay for the buffer.
   */
  keepForReplay(keep: boolean): void {
    this.keeping = keep
    if (keep) return
    this.kept.length = 0
    this.keptBytes = 0
  }

  /**
   * The frames after the one `id` names, in order; empty when it is the
   * last. Null when this channel cannot say what came after it: an id of
   * another channel (an earlier epoch, another process), or one older than
   * the buffer reaches. A run of frames that supersede each other (a tool's
   * streaming input) replays as its last.
   */
  framesAfter(id: string): WireFrame[] | null {
    const separator = id.lastIndexOf(':')
    const digits = id.slice(separator + 1)
    if (separator <= 0 || id.slice(0, separator) !== this.epoch || !/^\d+$/.test(digits)) return null
    const seq = Number(digits)
    if (seq > this.seq) return null
    const keptFrom = this.seq - this.kept.length
    if (seq < keptFrom) return null
    const missed = this.kept.slice(seq - keptFrom)
    return missed
      .filter((frame, i) => !frame.supersedes || frame.supersedes !== missed[i + 1]?.supersedes)
      .map(({ id: frameIdOf, data }) => ({ id: frameIdOf, data }))
  }

  /** Every event; returns the unsubscribe. */
  listen(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Every event that goes on the wire, as frames; returns the unsubscribe. */
  follow(follower: FrameListener): () => void {
    this.followers.add(follower)
    return () => {
      this.followers.delete(follower)
    }
  }

  private keep(frame: KeptFrame): void {
    this.kept.push(frame)
    this.keptBytes += frame.data.length
    while (this.kept.length > 0 && (this.kept.length > this.limits.maxFrames || this.keptBytes > this.limits.maxBytes)) {
      this.keptBytes -= this.kept.shift()!.data.length
    }
  }
}

function deliver<T>(listener: (value: T) => void, value: T): void {
  try {
    listener(value)
  } catch (error) {
    console.error('[SessionChannel] Listener failed:', error)
  }
}
