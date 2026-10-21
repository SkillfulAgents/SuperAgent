/**
 * A session's events as the actor hands them out: streams of data, read at
 * the reader's own pace and ended by cancelling them. Built over the agent's
 * `LiveSessions`, which calls its listeners as each event happens.
 */
import type { LiveSessions } from './live/live-sessions'
import type { SessionEvent, WireFrame } from './live/session-channel'
import { wireFrame } from './live/session-channels'

/**
 * How many frames a viewer may fall behind before its wire is cut. It comes
 * back with the last frame id it got, and is caught up from the replay buffer
 * or a snapshot, rather than being buffered for without bound.
 */
export const FOLLOW_MAX_PENDING_FRAMES = 4096

/** How often a viewer's wire carries a `ping` (what the session is doing), so an idle wire is not taken for a dead one. */
export const FOLLOW_PING_MS = 30_000

/**
 * `messages.subscribe`: every event of the session from now on, for the
 * app's own consumers. Nothing is dropped: they keep up.
 */
export function sessionEvents(live: LiveSessions, sessionId: string): ReadableStream<SessionEvent> {
  let release: (() => void) | undefined
  let unwatch: (() => void) | undefined
  return new ReadableStream<SessionEvent>({
    start(controller) {
      release = live.listen(sessionId, (event) => controller.enqueue(event))
      // The agent let go of: no event will come.
      unwatch = live.onDispose(() => {
        release?.()
        controller.close()
      })
    },
    cancel() {
      release?.()
      unwatch?.()
    },
  })
}

/**
 * `messages.follow`: a viewer's wire (see `LiveSessions.follow`), with a
 * `ping` every `FOLLOW_PING_MS`. Resolves once attached. A viewer more than
 * `FOLLOW_MAX_PENDING_FRAMES` behind finds the stream ended after the frames
 * it already holds.
 */
export async function sessionFrames(
  live: LiveSessions,
  sessionId: string,
  after: string | undefined,
  { pingMs = FOLLOW_PING_MS, maxPendingFrames = FOLLOW_MAX_PENDING_FRAMES } = {},
): Promise<ReadableStream<WireFrame>> {
  let controller!: ReadableStreamDefaultController<WireFrame>
  let release: (() => void) | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  let ended = false
  const end = () => {
    ended = true
    clearInterval(ping)
    release?.()
    unwatch()
  }
  // The agent let go of: no frame will come.
  const unwatch = live.onDispose(() => {
    if (ended) return
    end()
    controller.close()
  })
  const stream = new ReadableStream<WireFrame>(
    { start: (c) => { controller = c }, cancel: end },
    new CountQueuingStrategy({ highWaterMark: maxPendingFrames }),
  )
  const push = (frame: WireFrame) => {
    if (ended) return
    if ((controller.desiredSize ?? 0) <= 0) {
      end()
      controller.close()
      return
    }
    controller.enqueue(frame)
  }
  release = await live.follow(sessionId, after, push)
  // Cut off while catching up: nothing more to send it.
  if (ended) {
    release()
    return stream
  }
  ping = setInterval(() => {
    try {
      push(wireFrame({ type: 'ping', isActive: live.isActive(sessionId), turnOutcome: live.turnOutcome(sessionId) }))
    } catch (error) {
      // A ping that cannot be built ends the stream, not the process: it is thrown from a timer.
      end()
      controller.error(error)
    }
  }, pingMs)
  ping.unref?.()
  return stream
}
