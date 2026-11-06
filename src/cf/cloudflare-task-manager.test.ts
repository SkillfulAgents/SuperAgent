import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurableObjectState } from 'cloudflare:workers'

const app = vi.hoisted(() => ({
  boot: vi.fn(async () => {}),
  startBackgroundServices: vi.fn(async () => {}),
  stopBackgroundServices: vi.fn(async () => {}),
}))
vi.mock('./boot', () => app)

import { CloudflareTaskManager } from './cloudflare-task-manager'
import type { Env } from './index'

function taskManager() {
  let replaced = false
  let alarm: number | null = null
  const ctx = {
    id: { name: 'org', toString: () => 'org' },
    storage: {
      sql: {
        exec: () => {
          if (replaced) throw new Error('Durable Object reset because its code was updated.')
          return { toArray: () => [], one: () => undefined }
        },
      },
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => {
        alarm = time
      },
    },
  }
  const object = new CloudflareTaskManager(ctx as unknown as DurableObjectState, {} as Env)
  return { object, alarm: () => alarm, replace: () => { replaced = true } }
}

describe('CloudflareTaskManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const mock of Object.values(app)) mock.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts the background services once, and arms the alarm that wakes it after an eviction', async () => {
    const { object, alarm } = taskManager()

    await object.wake()
    await object.alarm()
    await object.wake()

    expect(app.boot).toHaveBeenCalledTimes(1)
    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
    expect(alarm()).not.toBeNull()
  })

  it('stops its background services once a deploy has replaced it, and only once', async () => {
    const { object, replace } = taskManager()
    await object.wake()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.stopBackgroundServices).not.toHaveBeenCalled()

    replace()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(app.stopBackgroundServices).toHaveBeenCalledTimes(1)
  })
})
