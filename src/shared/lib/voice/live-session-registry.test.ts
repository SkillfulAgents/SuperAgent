import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '../app-state'
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
afterEach(() => vi.useRealTimers())

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
    const registry = new LiveSessionRegistry(hangup)
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
    const registry = new LiveSessionRegistry(hangup)
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
    const a = new LiveSessionRegistry(opener)
    const b = new LiveSessionRegistry(closer)
    const handle = await open(a, 'alice', 'rtc-1')
    expect(await b.release(handle, 'alice')).toBe('closed')
    expect(closer).toHaveBeenCalledExactlyOnceWith('openai', 'rtc-1')
    expect(await a.release(handle, 'alice')).toBe('missing')
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(opener).not.toHaveBeenCalled()
  })

  it('still hangs up when its deadline timer fires after the entry is past keeping', async () => {
    const hangup = vi.fn<LiveSessionHangup>(async () => {})
    const registry = new LiveSessionRegistry(hangup)
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
    const registry = new LiveSessionRegistry(hangup)
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
    const a = new LiveSessionRegistry(opener)
    const b = new LiveSessionRegistry(closer)
    const handle = await open(a, 'alice', 'rtc-1')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await b.release(handle, 'alice')).toBe('closing')
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(opener).toHaveBeenCalledWith('openai', 'rtc-1')
    expect(await entries('alice')).toEqual([])
    warning.mockRestore()
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
    const registry = new LiveSessionRegistry(hangup)
    for (let i = 0; i < LIVE_SESSION_RECORD_MAX; i++) {
      expect(await registry.release(await open(registry, 'alice', `rtc-${i}`), 'alice')).toBe('closing')
    }
    expect(await countLiveSessions('alice')).toBe(0)
    expect(await registry.reserve('alice', 'openai')).toBeNull()
    // Another user's record is their own.
    expect(await registry.reserve('bob', 'openai')).not.toBeNull()
  })
})
