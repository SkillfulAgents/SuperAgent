import { background } from '@shared/lib/background'

/**
 * The frames waiting for one SSE client, written one at a time in the order
 * they were pushed, from `start()` on.
 *
 * A write resolves once the client's socket has taken the frame, so a client
 * that reads slower than events arrive leaves frames waiting here. That
 * backlog is bounded: once more than `maxFrames` frames or `maxBytes` of
 * frame data would be waiting, the queue drops them all, writes nothing more
 * and calls `onOverflow`. Its caller ends the stream, and the client
 * reconnects and refetches, as after any drop. A stream that silently skipped
 * events would leave the client wrong with no cue to refetch.
 */
export interface SseFrameQueue {
  /** Queue one frame (serialized as JSON); ignored once the queue overflowed or closed. */
  push(frame: unknown): void
  /** Start writing. Frames pushed before wait until then, so a stream can queue its greeting ahead of events that arrive while it sets up. */
  start(): void
  /** Nothing is waiting or being written: a keep-alive is only worth sending then. */
  readonly idle: boolean
  /** Write nothing more. A write in progress finishes on its own. */
  close(): void
}

export const SSE_FRAME_QUEUE_LIMITS = { maxFrames: 1_000, maxBytes: 1024 * 1024 }

export function createSseFrameQueue(options: {
  /** Writes one frame's data; resolves once the client's socket has taken it. */
  write: (data: string) => Promise<void>
  onOverflow: () => void
  maxFrames?: number
  maxBytes?: number
}): SseFrameQueue {
  const maxFrames = options.maxFrames ?? SSE_FRAME_QUEUE_LIMITS.maxFrames
  const maxBytes = options.maxBytes ?? SSE_FRAME_QUEUE_LIMITS.maxBytes
  let waiting: string[] = []
  let waitingBytes = 0
  let started = false
  let writing = false
  let closed = false

  const drain = async (): Promise<void> => {
    writing = true
    try {
      while (!closed && waiting.length > 0) {
        const data = waiting.shift()!
        waitingBytes -= data.length
        await options.write(data)
      }
    } finally {
      writing = false
    }
  }
  const kick = (): void => {
    if (started && !writing && !closed && waiting.length > 0) background(drain(), { name: 'sse-frame-queue.write' })
  }
  const drop = (): void => {
    closed = true
    waiting = []
    waitingBytes = 0
  }

  return {
    push(frame) {
      if (closed) return
      const data = JSON.stringify(frame)
      if (waiting.length + 1 > maxFrames || waitingBytes + data.length > maxBytes) {
        drop()
        options.onOverflow()
        return
      }
      waiting.push(data)
      waitingBytes += data.length
      kick()
    },
    start() {
      started = true
      kick()
    },
    get idle() {
      return !writing && waiting.length === 0
    },
    close: drop,
  }
}
