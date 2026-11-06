import { describe, expect, it, vi } from 'vitest'
import { backgroundSettled } from '@shared/lib/background'
import { createSseFrameQueue, SSE_FRAME_QUEUE_LIMITS } from './sse-frame-queue'

/** A client socket the test drains by hand: each write waits until it is taken. */
function slowClient() {
  const written: unknown[] = []
  const pending: Array<() => void> = []
  return {
    written,
    write: vi.fn((data: string) => new Promise<void>((resolve) => {
      pending.push(() => {
        written.push(JSON.parse(data))
        resolve()
      })
    })),
    /** The socket takes the frame being written. */
    async take() {
      pending.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    get inFlight() {
      return pending.length
    },
  }
}

describe('createSseFrameQueue', () => {
  it('writes nothing before start, then every frame in order, one at a time', async () => {
    const client = slowClient()
    const queue = createSseFrameQueue({ write: client.write, onOverflow: vi.fn() })

    queue.push({ type: 'connected' })
    queue.push({ n: 1 })
    expect(client.write).not.toHaveBeenCalled()
    queue.start()
    queue.push({ n: 2 })

    expect(client.inFlight).toBe(1)
    await client.take()
    expect(client.inFlight).toBe(1)
    await client.take()
    await client.take()
    expect(client.written).toEqual([{ type: 'connected' }, { n: 1 }, { n: 2 }])
    expect(queue.idle).toBe(true)
  })

  it('is idle only when nothing is waiting or being written', async () => {
    const client = slowClient()
    const queue = createSseFrameQueue({ write: client.write, onOverflow: vi.fn() })
    queue.start()
    expect(queue.idle).toBe(true)

    queue.push({ type: 'ping' })
    expect(queue.idle).toBe(false)
    await client.take()
    expect(queue.idle).toBe(true)
  })

  it('drops its backlog and reports once when a client falls more than maxFrames behind', async () => {
    const client = slowClient()
    const onOverflow = vi.fn()
    const queue = createSseFrameQueue({ write: client.write, onOverflow, maxFrames: 3 })
    queue.start()

    // One frame is with the socket; three more wait.
    for (let n = 0; n < 4; n++) queue.push({ n })
    expect(onOverflow).not.toHaveBeenCalled()
    queue.push({ n: 4 })
    expect(onOverflow).toHaveBeenCalledTimes(1)

    // Nothing more is written or queued, also once the socket takes the frame it had.
    queue.push({ n: 5 })
    await client.take()
    await client.take()
    await backgroundSettled()
    expect(client.written).toEqual([{ n: 0 }])
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })

  it('bounds the bytes waiting as well as the frames', () => {
    const client = slowClient()
    const onOverflow = vi.fn()
    // Each frame is 51 bytes of JSON.
    const queue = createSseFrameQueue({ write: client.write, onOverflow, maxBytes: 120 })

    queue.push({ body: 'x'.repeat(40) })
    queue.push({ body: 'x'.repeat(40) })
    expect(onOverflow).not.toHaveBeenCalled()
    queue.push({ body: 'x'.repeat(40) })
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })

  it('counts frames waiting before start against the bound', () => {
    const onOverflow = vi.fn()
    const queue = createSseFrameQueue({ write: vi.fn(), onOverflow, maxFrames: 2 })

    queue.push({ n: 0 })
    queue.push({ n: 1 })
    queue.push({ n: 2 })
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })

  it('writes nothing more once closed', async () => {
    const client = slowClient()
    const queue = createSseFrameQueue({ write: client.write, onOverflow: vi.fn() })
    queue.start()
    queue.push({ n: 0 })
    queue.push({ n: 1 })

    queue.close()
    queue.push({ n: 2 })
    await client.take()
    await client.take()
    await backgroundSettled()

    expect(client.written).toEqual([{ n: 0 }])
  })

  it('holds a thousand frames or a mebibyte by default', () => {
    expect(SSE_FRAME_QUEUE_LIMITS).toEqual({ maxFrames: 1_000, maxBytes: 1024 * 1024 })
  })
})
