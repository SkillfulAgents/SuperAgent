import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '../app-state'
import { LocalTaskManager } from '../background-work/local-task-manager'
import { getRequestUserId, runWithRequestUser } from '../platform-attribution/request-context'
import {
  activateLiveSession,
  cancelLiveSessionReservation,
  countLiveSessions,
  liveSessionsKey,
  LIVE_SESSION_RECORD_MAX,
  removeLiveSession,
  reserveLiveSession,
} from './live-session-admission'
import {
  LiveSessionRegistry,
  LIVE_SESSION_MAX_MS,
  LIVE_SESSION_PENDING_LEASE_MS,
  LIVE_SESSION_RETAIN_MS,
  type LiveSessionHangup,
} from './live-session-registry'

beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop()
  vi.useRealTimers()
})

const managers: LocalTaskManager[] = []

/** A registry as a process has it. Two of them stand for two processes, each with its own wakeups. */
function inOneProcess(hangup: LiveSessionHangup): LiveSessionRegistry {
  const manager = new LocalTaskManager()
  const registry = new LiveSessionRegistry(hangup, () => manager)
  manager.register(registry.hangUpTask)
  void manager.start()
  managers.push(manager)
  return registry
}

/** Starts a session through `registry` the way the route does, and returns its handle. */
async function open(registry: LiveSessionRegistry, owner: string, providerSessionId: string): Promise<string> {
  const reservation = await registry.reserve(owner, 'openai')
  if (!reservation) throw new Error(`${owner} was refused a session`)
  try {
    const started = await reservation.start(providerSessionId)
    if (!started) throw new Error('The reservation was gone')
    return started.handle
  } finally {
    await reservation.end()
  }
}

async function entries(owner: string) {
  return (await appState().get(liveSessionsKey(owner)))?.value.sessions.map(session => [session.id, session.state]) ?? []
}

describe('Live session cleanup', () => {
  it('frees admission slots on failed hangup and retries without losing cleanup handles', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {}).mockRejectedValue(new Error('Unavailable'))
    const registry = inOneProcess(hangup)
    for (let i = 0; i < 4; i++) {
      const handle = await open(registry, 'alice', `session-${i}`)
      expect(await registry.release(handle, 'alice')).toBe('closing')
    }
    expect(await countLiveSessions('alice')).toBe(0)
    hangup.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(hangup).toHaveBeenCalledTimes(8)
    expect(hangup).toHaveBeenLastCalledWith('openai', 'session-3')
    expect(await entries('alice')).toEqual([])
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(hangup).toHaveBeenCalledTimes(8)
  })

  it('keeps ownership, deduplicates concurrent releases, and bounds failed cleanup', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => { throw new Error('Unavailable') })
    const registry = inOneProcess(hangup)
    const handle = await open(registry, 'alice', 'rtc-1')
    expect(await registry.release(handle, 'bob')).toBe('missing')
    expect(hangup).not.toHaveBeenCalled()
    await Promise.all([registry.release(handle, 'alice'), registry.release(handle, 'alice')])
    expect(hangup).toHaveBeenCalledOnce()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    // The first attempt, three retries, and the last one at the deadline.
    expect(hangup).toHaveBeenCalledTimes(5)
    expect(await registry.release(handle, 'alice')).toBe('missing')
    expect(await entries('alice')).toEqual([])
    warning.mockRestore()
  })

  it('skips the deadline hangup of a session another process hung up', async () => {
    const opener = vi.fn<LiveSessionHangup>(async () => {})
    const closer = vi.fn<LiveSessionHangup>(async () => {})
    const a = inOneProcess(opener)
    const b = inOneProcess(closer)
    const handle = await open(a, 'alice', 'rtc-1')
    expect(await b.release(handle, 'alice')).toBe('closed')
    expect(closer).toHaveBeenCalledExactlyOnceWith('openai', 'rtc-1')
    expect(await a.release(handle, 'alice')).toBe('missing')
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(opener).not.toHaveBeenCalled()
  })

  it('still hangs up when its deadline timer fires after the entry is past keeping', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {})
    const registry = inOneProcess(hangup)
    await open(registry, 'alice', 'rtc-1')
    // The machine sleeps: the clock jumps past the entry's keeping while the
    // deadline timer still waits its full hour, so it fires after the record
    // has expired.
    vi.setSystemTime(Date.now() + LIVE_SESSION_RETAIN_MS + 60_000)
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(hangup).toHaveBeenCalledExactlyOnceWith('openai', 'rtc-1')
  })

  it('removes the entry of a session whose activation answer was lost, once AppState answers again', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {})
    const registry = inOneProcess(hangup)
    const state = appState()
    const real = { get: state.get.bind(state), compareAndSet: state.compareAndSet.bind(state), consume: state.consume.bind(state) }
    let outage = false
    const down = () => { throw new Error('AppState unavailable') }
    vi.spyOn(state, 'get').mockImplementation(async key => outage ? down() : real.get(key))
    vi.spyOn(state, 'consume').mockImplementation(async (key, options) => outage ? down() : real.consume(key, options))
    vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
      if (outage) down()
      const written = await real.compareAndSet(key, expected, value, options)
      // The activation lands, its answer is lost, and AppState stays down a while.
      if (JSON.stringify(value).includes('"active"')) {
        outage = true
        down()
      }
      return written
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const reservation = await registry.reserve('alice', 'openai')
      await expect(reservation!.start('rtc-1')).rejects.toThrow('Could not record the voice session')
      await reservation!.end()
      expect(hangup).toHaveBeenCalledExactlyOnceWith('openai', 'rtc-1')
      // Still down at the first retry.
      await vi.advanceTimersByTimeAsync(1000)
      outage = false
      expect(await countLiveSessions('alice')).toBe(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(await countLiveSessions('alice')).toBe(0)
      expect(await entries('alice')).toEqual([])
      // Logged once, not at every retry.
      expect(warning.mock.calls.filter(([message]) => String(message).includes('Could not remove'))).toHaveLength(1)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('hangs up at the deadline a session whose release failed in another process', async () => {
    const opener = vi.fn<LiveSessionHangup>(async () => {})
    const closer = vi.fn<LiveSessionHangup>(async () => { throw new Error('Unavailable') })
    const a = inOneProcess(opener)
    const b = inOneProcess(closer)
    const handle = await open(a, 'alice', 'rtc-1')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await b.release(handle, 'alice')).toBe('closing')
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(opener).toHaveBeenCalledWith('openai', 'rtc-1')
    expect(await entries('alice')).toEqual([])
    warning.mockRestore()
  })
})

describe('Live session wakeups', () => {
  const wakeups = () => managers.at(-1)!.scheduled()

  it('keeps one wakeup per session, at its deadline', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {})
    const registry = inOneProcess(hangup)
    const before = Date.now()
    const handle = await open(registry, 'alice', 'rtc-1')
    await open(registry, 'alice', 'rtc-2')
    expect(wakeups().map(job => job.taskType)).toEqual(['voice.hangup', 'voice.hangup'])
    expect(wakeups()[0]).toMatchObject({ id: `hangup:${handle}`, nextRunAt: before + LIVE_SESSION_MAX_MS })

    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS - 1)
    expect(hangup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(hangup.mock.calls.map(([, id]) => id).sort()).toEqual(['rtc-1', 'rtc-2'])
    expect(wakeups()).toEqual([])
    expect(await entries('alice')).toEqual([])
  })

  it('moves the wakeup forward on an explicit hangup, and retries at 1 s, 5 s and 30 s', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => { throw new Error('Unavailable') })
    const registry = inOneProcess(hangup)
    const handle = await open(registry, 'alice', 'rtc-1')
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    const released = Date.now()
    expect(await registry.release(handle, 'alice')).toBe('closing')
    expect(hangup).toHaveBeenCalledTimes(1)
    expect(wakeups()).toMatchObject([{ id: `hangup:${handle}`, nextRunAt: released + 1000 }])

    await vi.advanceTimersByTimeAsync(999)
    expect(hangup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(hangup).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4999)
    expect(hangup).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(hangup).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(hangup).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(hangup).toHaveBeenCalledTimes(4)

    // Retries spent: nothing more until the deadline, for one last attempt.
    expect(wakeups()).toMatchObject([{ nextRunAt: released - 10 * 60_000 + LIVE_SESSION_MAX_MS }])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(hangup).toHaveBeenCalledTimes(5)
    expect(wakeups()).toEqual([])
    warning.mockRestore()
  })

  it('stops at the hangup that succeeds', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {}).mockRejectedValueOnce(new Error('Unavailable'))
    const registry = inOneProcess(hangup)
    const handle = await open(registry, 'alice', 'rtc-1')
    expect(await registry.release(handle, 'alice')).toBe('closing')
    await vi.advanceTimersByTimeAsync(1000)
    expect(hangup).toHaveBeenCalledTimes(2)
    expect(wakeups()).toEqual([])
    expect(await entries('alice')).toEqual([])
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS * 2)
    expect(hangup).toHaveBeenCalledTimes(2)
  })

  it('makes one attempt when a release lands on a retry coming due', async () => {
    let finish!: () => void
    const hangup = vi.fn<LiveSessionHangup>(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockRejectedValueOnce(new Error('Unavailable'))
    const registry = inOneProcess(hangup)
    const handle = await open(registry, 'alice', 'rtc-1')
    expect(await registry.release(handle, 'alice')).toBe('closing')
    await vi.advanceTimersByTimeAsync(1000)
    expect(hangup).toHaveBeenCalledTimes(2)

    // A second release while that retry is out joins it rather than sending another.
    const again = registry.release(handle, 'alice')
    await vi.advanceTimersByTimeAsync(0)
    expect(hangup).toHaveBeenCalledTimes(2)
    finish()
    expect(await again).toBe('closed')
    expect(wakeups()).toEqual([])
  })

  it('hangs up at a wakeup as the user whose request brought the session here', async () => {
    const seen: Array<string | undefined> = []
    const hangup = vi.fn<LiveSessionHangup>(async () => { seen.push(getRequestUserId()) })
    const registry = inOneProcess(hangup)
    await runWithRequestUser('agent-owner', () => open(registry, 'alice', 'rtc-1'))
    expect(getRequestUserId()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(seen).toEqual(['agent-owner'])
  })

  it('retries a failed hangup as that user too, whoever or whatever runs the wakeup', async () => {
    const seen: Array<string | undefined> = []
    const hangup = vi.fn<LiveSessionHangup>(async () => {
      seen.push(getRequestUserId())
      if (seen.length === 1) throw new Error('Unavailable')
    })
    const registry = inOneProcess(hangup)
    const handle = await runWithRequestUser('alice-user', () => open(registry, 'alice', 'rtc-1'))
    expect(await runWithRequestUser('alice-user', () => registry.release(handle, 'alice'))).toBe('closing')
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['alice-user', 'alice-user'])
  })

  it('hangs up with no user for a session that came with none', async () => {
    const seen: Array<string | undefined> = []
    const hangup = vi.fn<LiveSessionHangup>(async () => { seen.push(getRequestUserId()) })
    const registry = inOneProcess(hangup)
    await open(registry, 'alice', 'rtc-1')
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(seen).toEqual([undefined])
  })

  it('makes no hangup after dispatch stops', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => { throw new Error('Unavailable') })
    const registry = inOneProcess(hangup)
    const handle = await open(registry, 'alice', 'rtc-1')
    expect(await registry.release(handle, 'alice')).toBe('closing')
    await managers.at(-1)!.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS * 2)
    expect(hangup).toHaveBeenCalledTimes(1)
  })

  it('sets a wakeup that does nothing for a session it no longer knows', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {})
    const registry = inOneProcess(hangup)
    await managers.at(-1)!.at(Date.now(), 'hangup:unknown', { taskType: 'voice.hangup', payload: { callId: 'unknown' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(hangup).not.toHaveBeenCalled()
    expect(registry).toBeDefined()
  })

  it('waits out a slow hangup at the deadline rather than sending a second', async () => {
    let finish!: () => void
    const hangup = vi.fn<LiveSessionHangup>(() => new Promise<void>((resolve) => { finish = resolve }))
    const registry = inOneProcess(hangup)
    await open(registry, 'alice', 'rtc-1')
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(hangup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hangup).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(wakeups()).toEqual([])
    expect(await entries('alice')).toEqual([])
  })
})

describe('Live session admission record', () => {
  it('leaves a session alone when a late cancel of its reservation arrives', async () => {
    const reservation = await reserveLiveSession('alice', 'openai')
    expect(await activateLiveSession('alice', reservation!.id, 'rtc-1')).not.toBeNull()
    await cancelLiveSessionReservation('alice', reservation!.id)
    expect(await entries('alice')).toEqual([[reservation!.id, 'active']])
    expect(await countLiveSessions('alice')).toBe(1)
  })

  it('does not start a reservation that was cancelled, or recreate it', async () => {
    const reservation = await reserveLiveSession('alice', 'openai')
    await cancelLiveSessionReservation('alice', reservation!.id)
    expect(await activateLiveSession('alice', reservation!.id, 'rtc-late')).toBeNull()
    expect(await entries('alice')).toEqual([])
  })

  it('does not start a reservation whose lease ran out', async () => {
    const reservation = await reserveLiveSession('alice', 'openai')
    vi.setSystemTime(Date.now() + LIVE_SESSION_PENDING_LEASE_MS)
    expect(await activateLiveSession('alice', reservation!.id, 'rtc-late')).toBeNull()
    expect(await countLiveSessions('alice')).toBe(0)
    expect(await entries('alice')).toEqual([[reservation!.id, 'pending']])
  })

  it('removes a created session, and never a pending one', async () => {
    const reservation = await reserveLiveSession('alice', 'openai')
    await removeLiveSession('alice', reservation!.id)
    expect(await entries('alice')).toEqual([[reservation!.id, 'pending']])
    await activateLiveSession('alice', reservation!.id, 'rtc-1')
    await removeLiveSession('alice', reservation!.id)
    expect(await entries('alice')).toEqual([])
  })

  it('refuses new sessions once the record is full of closing ones', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => { throw new Error('Unavailable') })
    const registry = inOneProcess(hangup)
    for (let i = 0; i < LIVE_SESSION_RECORD_MAX; i++) {
      expect(await registry.release(await open(registry, 'alice', `rtc-${i}`), 'alice')).toBe('closing')
    }
    expect(await countLiveSessions('alice')).toBe(0)
    expect(await registry.reserve('alice', 'openai')).toBeNull()
    // Another user's record is their own.
    expect(await registry.reserve('bob', 'openai')).not.toBeNull()
  })
})

describe('liveSessions', () => {
  it('stays one registry when the module is instantiated again, as Vite does after an edit', async () => {
    const before = (await import('./live-sessions')).liveSessions
    vi.resetModules()
    expect((await import('./live-sessions')).liveSessions).toBe(before)
  })
})
