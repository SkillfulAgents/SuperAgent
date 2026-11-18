/**
 * An agent's session channels, one per session someone listens to.
 *
 * A channel keeps frames for replay while a viewer follows it on the wire,
 * and for a grace period after the last one leaves, so a viewer whose
 * connection drops resumes from the last frame it got instead of starting
 * over. Then it stops keeping them; a channel nobody listens to at all is
 * dropped. The app's own listeners (`listen`) never make a channel keep
 * frames: they cannot come back for them. An event for a session with no
 * channel goes nowhere: no one could be missing it.
 */
import {
  DEFAULT_REPLAY_LIMITS,
  SessionChannel,
  type FrameListener,
  type ReplayLimits,
  type SessionEvent,
  type SessionListener,
  type WireFrame,
} from './session-channel'

/** Long enough for a client's automatic reconnect; short enough that idle sessions do not pile up. */
export const RECONNECT_GRACE_MS = 60_000

export function wireFrame(event: SessionEvent, id?: string): WireFrame {
  return { id, data: JSON.stringify(event) }
}

export interface FollowOptions {
  /** The id of the last frame the viewer got, when it is coming back. */
  after?: string
  /** What a viewer starting over is given first, as of the channel's last frame. */
  snapshot: (lastId: string) => WireFrame[]
}

export class SessionChannels {
  private readonly channels = new Map<string, SessionChannel>()
  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: { graceMs?: number; limits?: ReplayLimits } = {}) {}

  emit(sessionId: string, event: SessionEvent): void {
    this.channels.get(sessionId)?.emit(event)
  }

  /** Every event of the session from now on; returns the unsubscribe. */
  listen(sessionId: string, listener: SessionListener): () => void {
    const channel = this.channelFor(sessionId)
    return this.releasing(sessionId, channel, channel.listen(listener))
  }

  /**
   * A viewer's wire: first what it is missing, then every frame as it
   * happens. A viewer coming back (`after`) is given the frames since, when
   * the channel still holds them; otherwise the snapshot stands for
   * everything before. Catching up and attaching are one synchronous step:
   * no event falls between them.
   */
  follow(sessionId: string, options: FollowOptions, onFrame: FrameListener): () => void {
    const channel = this.channelFor(sessionId)
    this.cancelExpiry(sessionId)
    channel.keepForReplay(true)
    const release = this.releasing(sessionId, channel, channel.follow(onFrame))
    try {
      const missed = options.after === undefined ? null : channel.framesAfter(options.after)
      for (const frame of missed ?? options.snapshot(channel.lastId)) onFrame(frame)
    } catch (error) {
      release()
      throw error
    }
    return release
  }

  dispose(): void {
    for (const expiry of this.expiries.values()) clearTimeout(expiry)
    this.expiries.clear()
    this.channels.clear()
  }

  private channelFor(sessionId: string): SessionChannel {
    let channel = this.channels.get(sessionId)
    if (!channel) {
      channel = new SessionChannel(this.options.limits ?? DEFAULT_REPLAY_LIMITS)
      this.channels.set(sessionId, channel)
    }
    return channel
  }

  /** The unsubscribe, which also lets the channel wind down once the last viewer has gone. */
  private releasing(sessionId: string, channel: SessionChannel, unsubscribe: () => void): () => void {
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      unsubscribe()
      if (channel.followerCount > 0 || this.channels.get(sessionId) !== channel || this.expiries.has(sessionId)) return
      const expiry = setTimeout(() => {
        this.expiries.delete(sessionId)
        if (this.channels.get(sessionId) !== channel || channel.followerCount > 0) return
        channel.keepForReplay(false)
        if (channel.listenerCount === 0) this.channels.delete(sessionId)
      }, this.options.graceMs ?? RECONNECT_GRACE_MS)
      expiry.unref?.()
      this.expiries.set(sessionId, expiry)
    }
  }

  private cancelExpiry(sessionId: string): void {
    const expiry = this.expiries.get(sessionId)
    if (!expiry) return
    clearTimeout(expiry)
    this.expiries.delete(sessionId)
  }
}
