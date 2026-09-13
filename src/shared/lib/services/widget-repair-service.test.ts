import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionMetadata } from '@shared/lib/types/agent'

const mocks = vi.hoisted(() => ({
  hasActiveSessions: false,
  metadata: {} as Record<string, SessionMetadata>,
  ensureRunning: vi.fn(),
  createSession: vi.fn(),
  registerSession: vi.fn(async () => {}),
  subscribeToSession: vi.fn(async () => {}),
  markSessionActive: vi.fn(),
  broadcastGlobal: vi.fn(),
  logTail: null as string | null,
  ownerUserId: null as string | null,
  ranAsUser: undefined as string | null | undefined,
}))

// The actor reaches the container client through getClient after start();
// hand back whatever ensureRunning last resolved to.
let ensuredClient: unknown
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: async (...args: unknown[]) => {
      ensuredClient = await mocks.ensureRunning(...args)
      return ensuredClient
    },
    getClient: () => ensuredClient,
  },
}))
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    hasActiveSessionsForAgent: () => mocks.hasActiveSessions,
    subscribeToSession: (...args: unknown[]) => mocks.subscribeToSession(...(args as [])),
    markSessionActive: (...args: unknown[]) => mocks.markSessionActive(...args),
    broadcastGlobal: (...args: unknown[]) => mocks.broadcastGlobal(...args),
  },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({ agentModel: 'claude-x', browserModel: 'browser-x', dashboardBuilderModel: 'dash-x' }),
}))
vi.mock('@shared/lib/container/runtime-options', () => ({
  resolveRuntimeInherit: () => ({ model: 'claude-x', effort: 'medium' }),
}))
vi.mock('@shared/lib/platform-attribution/request-context', () => ({
  runWithOptionalUser: (userId: string | null | undefined, fn: () => unknown) => {
    mocks.ranAsUser = userId
    return fn()
  },
}))
vi.mock('./agent-owner', () => ({ getAgentOwnerUserId: () => mocks.ownerUserId }))
vi.mock('./agent-preferences-service', () => ({ readAgentPreferences: async () => ({}) }))
vi.mock('./secrets-service', () => ({ getSecretEnvVars: async () => ['API_KEY'] }))
vi.mock('./session-service', () => ({
  readSessionMetadata: async () => mocks.metadata,
  registerSession: (...args: unknown[]) => mocks.registerSession(...(args as [])),
}))
vi.mock('./widget-service', () => ({ readWidgetLogTail: async () => mocks.logTail }))

const { openWidgetRepairSession, REPAIR_COOLDOWN_MS } = await import('./widget-repair-service')

const AGENT = 'agent-1'
const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const ERROR = 'Refresh script failed (exit code 1): TypeError: reading "temp" of undefined'

describe('openWidgetRepairSession', () => {
  beforeEach(() => {
    mocks.hasActiveSessions = false
    mocks.metadata = {}
    mocks.logTail = null
    mocks.ownerUserId = null
    mocks.ranAsUser = undefined
    mocks.ensureRunning.mockReset()
    mocks.createSession.mockReset()
    mocks.registerSession.mockClear()
    mocks.subscribeToSession.mockClear()
    mocks.markSessionActive.mockClear()
    mocks.broadcastGlobal.mockClear()
    mocks.ensureRunning.mockResolvedValue({ createSession: mocks.createSession })
    mocks.createSession.mockResolvedValue({ id: 'session-new' })
  })

  it('opens a hidden automated session naming the widget, the error and the log', async () => {
    mocks.logTail = '[WidgetManager] running: bun run widget.ts\nTypeError: ...'

    const outcome = await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)

    expect(outcome).toEqual({ started: true, sessionId: 'session-new' })
    const created = mocks.createSession.mock.calls[0][0]
    expect(created.metadata).toEqual({ isAutomated: true })
    expect(created.availableEnvVars).toEqual(['API_KEY'])
    expect(created.initialMessage).toContain('/workspace/artifacts/weather/')
    expect(created.initialMessage).toContain(ERROR)
    expect(created.initialMessage).toContain('TypeError: ...')
    expect(created.initialMessage).toContain('widgets` skill')
    expect(mocks.registerSession).toHaveBeenCalledWith(AGENT, 'session-new', 'Invoked to fix widget', {
      isWidgetRepair: true,
      widgetRepairSlug: 'weather',
      automationStatus: 'running',
    })
    expect(mocks.subscribeToSession).toHaveBeenCalled()
    expect(mocks.markSessionActive).toHaveBeenCalledWith(AGENT, 'session-new')
    expect(mocks.broadcastGlobal).toHaveBeenCalledWith({
      type: 'session_updated',
      agentSlug: AGENT,
      sessionId: 'session-new',
    })
  })

  it('two widgets failing in the same sweep open one session, not two', async () => {
    // The durable guards are per widget and read from disk, and creating the
    // session takes long enough that both calls would otherwise pass the
    // "is the agent busy?" check before either had a session to be busy with.
    let release: () => void = () => {}
    let inFlight: () => void = () => {}
    const creating = new Promise<void>((resolve) => { inFlight = resolve })
    mocks.createSession.mockImplementation(async () => {
      inFlight()
      await new Promise<void>((resolve) => { release = resolve })
      return { id: 'session-new' }
    })

    const first = openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)
    await creating // the first repair is now mid-creation, with no session yet
    const second = await openWidgetRepairSession(AGENT, 'macros', ERROR, NOW)
    release()

    expect(await first).toEqual({ started: true, sessionId: 'session-new' })
    expect(second).toEqual({ started: false, reason: 'agent-busy' })
    expect(mocks.createSession).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way while the agent is mid-turn', async () => {
    mocks.hasActiveSessions = true
    expect(await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)).toEqual({
      started: false,
      reason: 'agent-busy',
    })
    expect(mocks.ensureRunning).not.toHaveBeenCalled()
  })

  it('does not stack a second repair while one is still running', async () => {
    mocks.metadata = {
      s1: { isWidgetRepair: true, widgetRepairSlug: 'weather', automationStatus: 'running', createdAt: '2026-09-08T11:59:00.000Z' },
    }
    expect(await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)).toEqual({
      started: false,
      reason: 'repair-in-flight',
    })
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('a widget that stays broken gets one session per cooldown window, not one per refresh', async () => {
    const finished: SessionMetadata = {
      isWidgetRepair: true,
      widgetRepairSlug: 'weather',
      automationStatus: 'failed',
      createdAt: new Date(NOW - 60_000).toISOString(),
    }
    mocks.metadata = { s1: finished }
    expect(await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)).toEqual({
      started: false,
      reason: 'cooldown',
    })

    // Once the window has passed, the next failure is worth another try.
    const later = NOW + REPAIR_COOLDOWN_MS + 1
    expect(await openWidgetRepairSession(AGENT, 'weather', ERROR, later)).toMatchObject({ started: true })
  })

  it('a repair left running by a restart stops blocking once the window passes', async () => {
    // finalizeAutomationStatus never ran, so this record says 'running' forever.
    mocks.metadata = {
      s1: {
        isWidgetRepair: true,
        widgetRepairSlug: 'weather',
        automationStatus: 'running',
        createdAt: new Date(NOW - REPAIR_COOLDOWN_MS - 1).toISOString(),
      },
    }
    expect(await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)).toMatchObject({ started: true })
  })

  it('scopes the cooldown to the widget, not the agent', async () => {
    mocks.metadata = {
      s1: { isWidgetRepair: true, widgetRepairSlug: 'weather', automationStatus: 'running', createdAt: new Date(NOW).toISOString() },
    }
    expect(await openWidgetRepairSession(AGENT, 'macros', ERROR, NOW)).toMatchObject({ started: true })
  })

  it('attributes the session to the agent owner in auth mode', async () => {
    mocks.ownerUserId = 'user-7'
    await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)
    expect(mocks.ranAsUser).toBe('user-7')
  })

  it('reports a container that will not start instead of throwing', async () => {
    mocks.ensureRunning.mockRejectedValue(new Error('container is wedged'))
    expect(await openWidgetRepairSession(AGENT, 'weather', ERROR, NOW)).toEqual({
      started: false,
      reason: 'container-error',
    })
  })
})
