import type { Context } from 'hono'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'
import {
  activateLiveSession,
  countLiveSessions,
  liveSessionsKey,
  LIVE_SESSION_MAX_MS,
  LIVE_SESSION_PENDING_LEASE_MS,
  reserveLiveSession,
} from '@shared/lib/voice/live-session-admission'

// Two copies of the route module stand for two processes serving one tenant:
// each has its own module state (registry) and its own task manager, and
// AppState, held on globalThis, is the one thing they share.
const mocks = vi.hoisted(() => ({
  selected: 'openai',
  user: 'alice',
  keys: {} as Record<string, string>,
  sessions: 0,
  create: vi.fn(),
  close: { openai: vi.fn(), platform: vi.fn() } as Record<string, ReturnType<typeof vi.fn>>,
}))
vi.mock('../middleware/auth', () => ({
  Authenticated: () => async (_c: unknown, next: () => Promise<void>) => next(),
  ResolveAgent: () => async (c: Context, next: () => Promise<void>) => { c.set('agentId', 'agent-id'); return next() },
  AgentUser: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAgentId: (c: Context) => c.get('agentId'),
}))
// The route reads the settings once per request: the selected provider and the capability policies.
vi.mock('@shared/lib/config/settings', () => ({ getSettings: async () => ({ voice: { sttProvider: mocks.selected }, agentCapabilities: {} }) }))
vi.mock('@shared/lib/voice', () => ({
  getVoiceProvider: (id: string) => ({
    id,
    name: id,
    getLiveConversation: () => ({
      createLiveSession: mocks.create, closeLiveSession: mocks.close[id], mapLiveConversation: vi.fn(),
      getLiveVoices: () => [], resolveLiveVoice: () => 'marin',
    }),
    // The key as it is configured now, read at each call.
    getEffectiveApiKey: () => mocks.keys[id],
  }),
}))
vi.mock('@shared/lib/auth/config', () => ({ getCurrentUserId: () => mocks.user }))
vi.mock('@shared/lib/agent-integrations/live-setting', () => ({ resolveLiveConversationSetting: vi.fn() }))
vi.mock('@shared/lib/services/user-settings-service', () => ({ getUserSettings: () => ({}) }))
vi.mock('@shared/lib/services/agent-service', () => ({ getAgent: vi.fn() }))
import first from './voice'
import { liveSessions as firstSessions } from '@shared/lib/voice/live-sessions'
import { taskManager } from '@shared/lib/background-work'
import { LocalTaskManager } from '@shared/lib/background-work/local-task-manager'

let second: typeof first
let secondSessions: typeof firstSessions
let secondManager: LocalTaskManager
beforeAll(async () => {
  vi.resetModules()
  // Another process has a registry of its own, where a reloaded module shares this one's.
  delete (globalThis as { liveSessions?: unknown }).liveSessions
  vi.doMock('@shared/lib/background-work', async (importOriginal) => ({
    ...await importOriginal<typeof import('@shared/lib/background-work')>(),
    taskManager: () => secondManager,
  }))
  second = (await import('./voice')).default
  secondSessions = (await import('@shared/lib/voice/live-sessions')).liveSessions
  vi.doUnmock('@shared/lib/background-work')
  expect(second).not.toBe(first)
  expect(secondSessions).not.toBe(firstSessions)
})

function answer(id = `rtc-${++mocks.sessions}`) {
  return { session: { id }, transport: { type: 'webrtc', sdp: 'answer' } }
}
function start(app: typeof first, signal?: AbortSignal) {
  return app.request('/live/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: 'offer', history: [] }), signal,
  })
}
async function started(app: typeof first): Promise<string> {
  const response = await start(app)
  expect(response.status).toBe(201)
  return (await response.json()).handle
}
function release(app: typeof first, handle: string) {
  return app.request(`/live/session/${handle}`, { method: 'DELETE' })
}
async function entries(owner = 'alice') {
  return (await appState().get(liveSessionsKey(owner)))?.value.sessions.map(session => [session.id, session.state]) ?? []
}

beforeEach(() => {
  // Real time keeps passing; useRealTimers() drops the retries and deadlines a test leaves behind.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  taskManager().register(firstSessions.hangUpTask)
  secondManager = new LocalTaskManager()
  secondManager.register(secondSessions.hangUpTask)
  void secondManager.start()
  mocks.selected = 'openai'
  mocks.user = 'alice'
  mocks.keys = { openai: 'openai-key-1', platform: 'platform-token-1' }
  mocks.create.mockReset().mockImplementation(async () => answer())
  for (const close of Object.values(mocks.close)) close.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await secondManager.stop()
  vi.useRealTimers()
})

describe('Live voice admission across processes', () => {
  it('admits exactly four of six concurrent starts split across two processes', async () => {
    // Slow creation: every start is admitted or refused before any session exists.
    mocks.create.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return answer()
    })
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => start(index % 2 ? second : first)))
    expect(responses.map(response => response.status).sort()).toEqual([201, 201, 201, 201, 429, 429])
    expect(mocks.create).toHaveBeenCalledTimes(4)
    expect(await countLiveSessions('alice')).toBe(4)
  })

  it('frees the place of a start that failed', async () => {
    mocks.create.mockRejectedValue(new Error('Provider unavailable'))
    const failed = await Promise.all([first, second, first, second].map(app => start(app)))
    expect(failed.map(response => response.status)).toEqual([502, 502, 502, 502])
    expect(await entries()).toEqual([])
    mocks.create.mockImplementation(async () => answer())
    for (const app of [second, first, second, first]) await started(app)
    expect((await start(first)).status).toBe(429)
  })

  it('frees a reservation nobody renews when its lease runs out, and keeps one that is renewed', async () => {
    // Left by a process that is gone: nothing renews them.
    for (let i = 0; i < 4; i++) await reserveLiveSession('alice', 'openai')
    expect((await start(first)).status).toBe(429)
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_PENDING_LEASE_MS)

    // Creation that takes five leases: the process creating renews its reservations.
    const creationMs = 5 * LIVE_SESSION_PENDING_LEASE_MS
    mocks.create.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, creationMs))
      return answer()
    })
    const slow = Array.from({ length: 4 }, () => start(first))
    await vi.advanceTimersByTimeAsync(creationMs - 1000)
    expect(mocks.create).toHaveBeenCalledTimes(4)
    mocks.create.mockImplementation(async () => answer())
    expect((await start(second)).status).toBe(429)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await Promise.all(slow)).map(response => response.status)).toEqual([201, 201, 201, 201])
    expect(await countLiveSessions('alice')).toBe(4)
  })

  it('hangs up a session created after its request was cancelled, and does not record it', async () => {
    let finish!: () => void
    mocks.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(answer('rtc-cancelled')) }))
    const controller = new AbortController()
    const response = start(first, controller.signal)
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(await countLiveSessions('alice')).toBe(1)
    controller.abort()
    // The place is given back while the provider is still working.
    await vi.waitFor(async () => expect(await countLiveSessions('alice')).toBe(0))
    mocks.keys.openai = 'openai-key-2'
    finish()
    expect((await response).status).toBe(408)
    expect(mocks.close.openai).toHaveBeenCalledExactlyOnceWith('rtc-cancelled', 'openai-key-2')
    expect(await entries()).toEqual([])
  })

  it('hangs up a session created after its lease ran out, and does not record it', async () => {
    let finish!: () => void
    mocks.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(answer('rtc-late')) }))
    const response = start(first)
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled())
    // The process stalls past the lease: the clock moves, and no renewal runs.
    vi.setSystemTime(Date.now() + LIVE_SESSION_PENDING_LEASE_MS)
    expect(await countLiveSessions('alice')).toBe(0)
    finish()
    const late = await response
    expect(late.status).toBe(408)
    expect(await late.json()).toEqual({ error: 'Voice connection request timed out. Try again.' })
    expect(mocks.close.openai).toHaveBeenCalledExactlyOnceWith('rtc-late', 'openai-key-1')
    expect(await countLiveSessions('alice')).toBe(0)
    expect((await entries()).filter(([, state]) => state !== 'pending')).toEqual([])
  })

  it.each([
    ['lands but its answer is lost', true],
    ['fails', false],
  ])('hangs up a session whose recording %s, and does not count it', async (_, lands) => {
    const state = appState()
    const compareAndSet = state.compareAndSet.bind(state)
    const spy = vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
      const activating = JSON.stringify(value).includes('"active"')
      if (activating && !lands) throw new Error('AppState unavailable')
      const written = await compareAndSet(key, expected, value, options)
      if (activating) throw new Error('AppState timed out')
      return written
    })
    try {
      mocks.create.mockImplementationOnce(async () => answer('rtc-unrecorded'))
      const response = await start(first)
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'Could not record the voice session. Try again.' })
    } finally {
      spy.mockRestore()
    }
    expect(mocks.close.openai).toHaveBeenCalledExactlyOnceWith('rtc-unrecorded', 'openai-key-1')
    expect(await entries()).toEqual([])
  })

  it('does not let a delayed close remove a session started after it', async () => {
    const x = await started(first)
    let finishClose!: () => void
    mocks.close.openai.mockImplementationOnce(() => new Promise<void>(resolve => { finishClose = resolve }))
    const closing = release(second, x)
    await vi.waitFor(() => expect(mocks.close.openai).toHaveBeenCalled())
    const y = await started(first)
    expect(await entries()).toEqual([[x, 'closing'], [y, 'active']])
    finishClose()
    expect((await closing).status).toBe(200)
    expect(await entries()).toEqual([[y, 'active']])
    expect(await countLiveSessions('alice')).toBe(1)
  })

  it('releases from the other process, through the creating provider with its key as configured now', async () => {
    mocks.create.mockImplementationOnce(async () => answer('rtc-openai'))
    const handle = await started(first)
    mocks.keys.openai = 'openai-key-rotated'
    mocks.selected = 'platform'
    // The record is per user: another user's release finds nothing.
    mocks.user = 'bob'
    expect((await release(second, handle)).status).toBe(404)
    expect(mocks.close.openai).not.toHaveBeenCalled()
    mocks.user = 'alice'
    expect((await release(second, handle)).status).toBe(200)
    expect(mocks.close.openai).toHaveBeenCalledExactlyOnceWith('rtc-openai', 'openai-key-rotated')
    expect(mocks.close.platform).not.toHaveBeenCalled()
    expect((await release(first, handle)).status).toBe(404)
    expect(await entries()).toEqual([])
  })

  it('does not count sessions that are closing', async () => {
    mocks.close.openai.mockRejectedValue(new Error('Temporary upstream failure'))
    const handles: string[] = []
    for (let i = 0; i < 4; i++) handles.push(await started(first))
    expect((await start(second)).status).toBe(429)
    for (const handle of handles) expect((await release(second, handle)).status).toBe(202)
    expect(await countLiveSessions('alice')).toBe(0)
    await started(second)
    await started(first)
  })

  it('ends a session after an hour: the process that opened it hangs it up', async () => {
    for (let i = 0; i < 4; i++) await started(first)
    expect((await start(second)).status).toBe(429)
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS)
    expect(mocks.close.openai).toHaveBeenCalledTimes(4)
    expect(await entries()).toEqual([])
    await started(second)
  })

  it('stops counting a session whose process is gone at its deadline, without a hangup', async () => {
    for (let i = 0; i < 4; i++) {
      const reservation = await reserveLiveSession('alice', 'openai')
      await activateLiveSession('alice', reservation!.id, `rtc-gone-${i}`)
    }
    expect((await start(first)).status).toBe(429)
    await vi.advanceTimersByTimeAsync(LIVE_SESSION_MAX_MS - 1000)
    expect((await start(first)).status).toBe(429)
    await vi.advanceTimersByTimeAsync(1000)
    await started(first)
    expect(mocks.close.openai).not.toHaveBeenCalled()
  })
})
