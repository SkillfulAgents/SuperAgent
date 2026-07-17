import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// DB-driven health-check reconcile.
//
// The old runHealthChecks iterated the in-memory `connections` map, and both
// reconnect paths did removeIntegration → connectIntegration. A single failed
// connect left the integration absent from the map, so no later tick ever saw
// it again — permanently dead until app restart, with whatever status happened
// to be in the DB at the time ("stops responding").
//
// The reconcile loop instead treats the DB as the work list: every startup-
// eligible integration (status active/error) is checked each tick, so a failed
// reconnect is simply retried on the next tick. These tests drive
// runHealthChecks() directly with the service layer mocked and connectors
// stubbed, and assert:
//   1. an orphaned integration (in DB, not in the map) is reconnected,
//   2. a FAILED reconnect is retried on the next tick (the regression),
//   3. the failure counter survives ticks so auto-pause is reachable,
//   4. a present-but-disconnected connector gets a grace window before the
//      manager tears it down (its own reconnect loop goes first),
//   5. recovery writes status 'active' back (both via manager reconnect and
//      via connector self-recovery), so no stale error badge remains,
//   6. healthy integrations cause zero writes and zero rebuilds,
//   7. a failed attempt records status 'error' with the attempt count,
//   8. per-integration in-flight guard: overlapping ticks don't double-connect,
//   9. an integration paused mid-tick is not reconnected.
// ---------------------------------------------------------------------------

vi.mock('@shared/lib/services/chat-integration-service', () => ({
  listStartupChatIntegrations: vi.fn().mockReturnValue([]),
  getChatIntegration: vi.fn(),
  updateChatIntegrationStatus: vi.fn(),
}))

vi.mock('@shared/lib/services/chat-integration-session-service', () => ({
  getChatIntegrationSession: vi.fn(),
  getChatIntegrationSessionBySessionId: vi.fn(),
  createChatIntegrationSession: vi.fn(),
  updateChatIntegrationSessionName: vi.fn(),
  archiveChatIntegrationSession: vi.fn(),
  touchChatIntegrationSession: vi.fn(),
  listChatIntegrationSessions: vi.fn().mockReturnValue([]),
  listActiveChatIntegrationSessions: vi.fn().mockReturnValue([]),
  resolveActiveSession: vi.fn(),
  getLastDisplayName: vi.fn(),
}))

vi.mock('@shared/lib/services/chat-integration-access-service', () => ({
  decideInboundAccess: vi.fn(),
  isChatAllowed: vi.fn().mockReturnValue(true),
  getChatAccess: vi.fn(),
  markNoticeSent: vi.fn(),
}))

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    addGlobalNotificationClient: vi.fn().mockReturnValue(() => {}),
    getSessionActivity: vi.fn(),
  },
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
  addErrorBreadcrumb: vi.fn(),
}))

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerChatIntegrationEvent: vi.fn().mockResolvedValue(undefined),
  },
}))

import { chatIntegrationManager } from './chat-integration-manager'
import {
  listStartupChatIntegrations,
  getChatIntegration,
  updateChatIntegrationStatus,
} from '@shared/lib/services/chat-integration-service'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import type { ChatClientConnector } from './base-connector'
import type { ChatIntegration } from '@shared/lib/db/schema'

const listStartupMock = vi.mocked(listStartupChatIntegrations)
const getIntegrationMock = vi.mocked(getChatIntegration)
const updateStatusMock = vi.mocked(updateChatIntegrationStatus)

interface ManagerTestSurface {
  connections: Map<string, { connector: ChatClientConnector }>
  chatSessions: Map<string, unknown>
  messageQueues: Map<string, unknown>
  disconnectedSince: Map<string, number>
  consecutiveFailures: Map<string, number>
  reconcilingIds: Set<string>
  generations?: Map<string, number>
  isRunning: boolean
  runHealthChecks(): Promise<void>
  createConnector(integration: unknown): Promise<ChatClientConnector>
  pauseIntegration(id: string): Promise<void>
  removeIntegration(id: string): Promise<void>
  addIntegration(id: string): Promise<void>
  stop(): void
}

const mgr = chatIntegrationManager as unknown as ManagerTestSurface

const INT = 'int-reconcile-test'

function integrationRow(overrides?: Partial<ChatIntegration>): ChatIntegration {
  return {
    id: INT,
    agentSlug: 'test-agent',
    provider: 'telegram',
    name: 'Test Bot',
    status: 'active',
    statusError: null,
    requireApproval: true,
    sessionTimeout: null,
    createdByUserId: null,
    config: '{}',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as unknown as ChatIntegration
}

interface FakeConnector extends ChatClientConnector {
  connectedState: boolean
}

function fakeConnector(opts?: {
  connectImpl?: () => Promise<void>
  disconnectImpl?: () => Promise<void>
}): FakeConnector {
  const c = {
    provider: 'telegram',
    connectedState: true,
    connect: vi.fn(opts?.connectImpl ?? (async () => {})),
    disconnect: vi.fn(opts?.disconnectImpl ?? (async () => {})),
    isConnected: vi.fn(() => c.connectedState),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onInteractiveResponse: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onTypingHint: vi.fn().mockReturnValue(() => {}),
  }
  return c as unknown as FakeConnector
}

/** Seed the DB mocks so `row` is the single startup-eligible integration. */
function seedRow(row: ChatIntegration): void {
  listStartupMock.mockReturnValue([row])
  getIntegrationMock.mockReturnValue(row)
}

function resetManagerState(): void {
  mgr.connections.clear()
  mgr.chatSessions.clear()
  mgr.messageQueues.clear()
  mgr.disconnectedSince.clear()
  mgr.consecutiveFailures.clear()
  mgr.reconcilingIds?.clear()
  mgr.generations?.clear()
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagerState()
  listStartupMock.mockReturnValue([])
  mgr.isRunning = true
})

afterEach(() => {
  vi.restoreAllMocks()
  resetManagerState()
  mgr.isRunning = false
})

describe('reconcile: DB-driven health check', () => {
  it('reconnects an orphaned integration (in DB, missing from the connections map)', async () => {
    const row = integrationRow({ status: 'error' } as Partial<ChatIntegration>)
    seedRow(row)
    const connector = fakeConnector()
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(connector)

    await mgr.runHealthChecks()

    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(connector.connect).toHaveBeenCalledTimes(1)
    expect(mgr.connections.has(INT)).toBe(true)
  })

  it('REGRESSION: a failed reconnect is retried on the next tick, not orphaned forever', async () => {
    seedRow(integrationRow())
    const failing = fakeConnector({ connectImpl: async () => { throw new Error('network down') } })
    const working = fakeConnector()
    const createSpy = vi.spyOn(mgr, 'createConnector')
    createSpy.mockResolvedValueOnce(failing).mockResolvedValueOnce(working)

    // Tick 1: connect fails — integration must NOT silently vanish from the work list.
    await mgr.runHealthChecks()
    expect(failing.connect).toHaveBeenCalledTimes(1)
    expect(mgr.connections.has(INT)).toBe(false)

    // Tick 2: the DB-driven loop tries again and recovers.
    await mgr.runHealthChecks()
    expect(working.connect).toHaveBeenCalledTimes(1)
    expect(mgr.connections.has(INT)).toBe(true)
  })

  it('failure counter survives ticks; auto-pause fires after the max, then attempts stop', async () => {
    const row = integrationRow()
    seedRow(row)
    vi.spyOn(mgr, 'createConnector').mockImplementation(async () =>
      fakeConnector({ connectImpl: async () => { throw new Error('still down') } }))

    for (let i = 0; i < 15; i++) {
      await mgr.runHealthChecks()
    }

    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'paused', expect.stringContaining('Auto-paused'))
    expect(mgr.consecutiveFailures.has(INT)).toBe(false)

    // Once paused the service stops listing it — no further attempts.
    listStartupMock.mockReturnValue([])
    const attemptsSoFar = vi.mocked(mgr.createConnector).mock.calls.length
    await mgr.runHealthChecks()
    expect(vi.mocked(mgr.createConnector).mock.calls.length).toBe(attemptsSoFar)
  })

  it('gives a present-but-disconnected connector a grace window before rebuilding', async () => {
    seedRow(integrationRow())
    const dead = fakeConnector()
    dead.connectedState = false
    mgr.connections.set(INT, { connector: dead } as never)
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    // First tick inside the grace window: the connector's own reconnect loop
    // (iMessage backoff, Slack socket-mode restart) gets to try first.
    await mgr.runHealthChecks()
    expect(createSpy).not.toHaveBeenCalled()
    expect(mgr.connections.get(INT)?.connector).toBe(dead)

    // Past the grace window the manager steps in and rebuilds.
    mgr.disconnectedSince.set(INT, Date.now() - 10 * 60 * 1000)
    await mgr.runHealthChecks()
    expect(createSpy).toHaveBeenCalledTimes(1)
  })

  it('writes status active back after a successful manager reconnect of an error-status row', async () => {
    seedRow(integrationRow({ status: 'error' } as Partial<ChatIntegration>))
    vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    await mgr.runHealthChecks()

    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'active', null)
  })

  it('clears a stale error badge when the connector self-recovered', async () => {
    seedRow(integrationRow({ status: 'error' } as Partial<ChatIntegration>))
    const healthy = fakeConnector() // connectedState=true: recovered on its own
    mgr.connections.set(INT, { connector: healthy } as never)
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    await mgr.runHealthChecks()

    // No rebuild — just the badge fix.
    expect(createSpy).not.toHaveBeenCalled()
    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'active', null)
  })

  it('does nothing for a healthy active integration', async () => {
    seedRow(integrationRow())
    mgr.connections.set(INT, { connector: fakeConnector() } as never)
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    await mgr.runHealthChecks()

    expect(createSpy).not.toHaveBeenCalled()
    expect(updateStatusMock).not.toHaveBeenCalled()
  })

  it('records status error with the attempt count on a failed reconnect', async () => {
    seedRow(integrationRow())
    vi.spyOn(mgr, 'createConnector').mockImplementation(async () =>
      fakeConnector({ connectImpl: async () => { throw new Error('boom') } }))

    await mgr.runHealthChecks()
    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'error', expect.stringContaining('attempt 1'))

    await mgr.runHealthChecks()
    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'error', expect.stringContaining('attempt 2'))
  })

  it('notifies the user on the first failure only, not every tick', async () => {
    seedRow(integrationRow())
    vi.spyOn(mgr, 'createConnector').mockImplementation(async () =>
      fakeConnector({ connectImpl: async () => { throw new Error('boom') } }))

    await mgr.runHealthChecks()
    await mgr.runHealthChecks()
    await mgr.runHealthChecks()
    // Let the fire-and-forget dynamic import in emitNotification settle.
    await new Promise((r) => setTimeout(r, 0))

    const errorNotifications = vi.mocked(notificationManager.triggerChatIntegrationEvent)
      .mock.calls.filter((c) => c[3] === 'error')
    expect(errorNotifications.length).toBe(1)
  })

  it('in-flight guard: an integration mid-reconnect is skipped by the next tick', async () => {
    seedRow(integrationRow())
    let releaseConnect: () => void = () => {}
    const hanging = fakeConnector({
      connectImpl: () => new Promise<void>((resolve) => { releaseConnect = resolve }),
    })
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(hanging)

    const tick1 = mgr.runHealthChecks()
    // Give tick1 a chance to enter the connect await.
    await new Promise((r) => setTimeout(r, 0))
    await mgr.runHealthChecks() // overlapping tick — must not double-connect

    expect(createSpy).toHaveBeenCalledTimes(1)

    releaseConnect()
    await tick1
    expect(mgr.connections.has(INT)).toBe(true)
  })

  it('skips an integration paused between the list snapshot and the attempt', async () => {
    const row = integrationRow()
    listStartupMock.mockReturnValue([row])
    // Fresh re-read says paused — user acted mid-tick.
    getIntegrationMock.mockReturnValue({ ...row, status: 'paused' } as ChatIntegration)
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    await mgr.runHealthChecks()

    expect(createSpy).not.toHaveBeenCalled()
    expect(mgr.connections.has(INT)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle operations racing an in-flight rebuild.
//
// A rebuild spans two await gaps — the old connector's teardown and the new
// connector's connect — and user lifecycle operations (pause, delete, config
// update) can land inside either. Every public lifecycle mutation bumps a
// per-integration generation; a rebuild captures the generation up front and
// treats any change as CANCELLATION: no reconnect from its (now stale) row
// snapshot, no status writes over what the user's operation just wrote, and
// any socket it opened anyway is torn down. Without this, a background rebuild
// could resurrect a paused integration or restore pre-update credentials.
// ---------------------------------------------------------------------------

describe('reconcile: lifecycle operations racing a rebuild', () => {
  /** Let the microtask queue drain so an in-flight rebuild reaches its next await. */
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('a pause landing during the teardown await cancels the rebuild (stale-row reconnect)', async () => {
    const row = integrationRow()
    seedRow(row) // getChatIntegration keeps returning the stale ACTIVE row: only the generation can save us
    let releaseDisconnect: () => void = () => {}
    const dead = fakeConnector({
      disconnectImpl: () => new Promise<void>((r) => { releaseDisconnect = r }),
    })
    dead.connectedState = false
    mgr.connections.set(INT, { connector: dead } as never)
    mgr.disconnectedSince.set(INT, Date.now() - 10 * 60 * 1000) // grace expired
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    const tick = mgr.runHealthChecks()
    await settle() // rebuild is now awaiting the old connector's teardown

    await mgr.pauseIntegration(INT) // user pauses; returns successfully
    releaseDisconnect()
    await tick

    // The rebuild must stand down completely: no reconnect, no status write
    // over the pause, nothing left in the map.
    expect(createSpy).not.toHaveBeenCalled()
    expect(mgr.connections.has(INT)).toBe(false)
    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'paused')
    expect(updateStatusMock).not.toHaveBeenCalledWith(INT, 'error', expect.anything())
  })

  it('a pause landing during the connect await tears the new connector down and writes no active badge', async () => {
    seedRow(integrationRow({ status: 'error' } as Partial<ChatIntegration>))
    let releaseConnect: () => void = () => {}
    const connector = fakeConnector({
      connectImpl: () => new Promise<void>((r) => { releaseConnect = r }),
    })
    vi.spyOn(mgr, 'createConnector').mockResolvedValue(connector)

    const tick = mgr.runHealthChecks() // orphan rebuild starts, connect in flight
    await settle()

    await mgr.pauseIntegration(INT)
    releaseConnect() // the connect "succeeds" — but the user owns the integration now
    await tick

    expect(mgr.connections.has(INT)).toBe(false)
    expect(connector.disconnect).toHaveBeenCalled()
    // The error-row success path must NOT write 'active' over the fresh 'paused'.
    expect(updateStatusMock).not.toHaveBeenCalledWith(INT, 'active', null)
  })

  it('a connect FAILURE after a pause writes no error status and counts no failure', async () => {
    seedRow(integrationRow())
    let rejectConnect: (e: Error) => void = () => {}
    const connector = fakeConnector({
      connectImpl: () => new Promise<void>((_r, rej) => { rejectConnect = rej }),
    })
    vi.spyOn(mgr, 'createConnector').mockResolvedValue(connector)

    const tick = mgr.runHealthChecks()
    await settle()

    await mgr.pauseIntegration(INT)
    rejectConnect(new Error('socket torn down by the pause'))
    await tick

    // A cancelled rebuild reports nothing: writing 'error' here would flip the
    // row back to startup-eligible and resurrect the paused integration.
    expect(updateStatusMock).not.toHaveBeenCalledWith(INT, 'error', expect.anything())
    expect(mgr.consecutiveFailures.has(INT)).toBe(false)
  })

  it('a config update mid-rebuild wins: the stale rebuild does not resurrect the old connector', async () => {
    const rowV1 = integrationRow({ config: '{"v":1}' } as Partial<ChatIntegration>)
    const rowV2 = integrationRow({ config: '{"v":2}' } as Partial<ChatIntegration>)
    seedRow(rowV1)

    let releaseOldConnect: () => void = () => {}
    const connOld = fakeConnector({
      connectImpl: () => new Promise<void>((r) => { releaseOldConnect = r }),
    })
    const connNew = fakeConnector()
    let calls = 0
    vi.spyOn(mgr, 'createConnector').mockImplementation(async () => (++calls === 1 ? connOld : connNew))

    const tick = mgr.runHealthChecks() // rebuild from rowV1, connect in flight
    await settle()

    // Route-style config update: remove + add with the new row.
    await mgr.removeIntegration(INT)
    seedRow(rowV2)
    await mgr.addIntegration(INT)
    expect(mgr.connections.get(INT)?.connector).toBe(connNew)

    releaseOldConnect() // the STALE connect (old credentials) resolves late
    await tick

    // The new-credential connector must still own the integration; the stale
    // one must be torn down, not installed.
    expect(mgr.connections.get(INT)?.connector).toBe(connNew)
    expect(connOld.disconnect).toHaveBeenCalled()
    expect(connNew.disconnect).not.toHaveBeenCalled()
  })

  it("a stale rebuild's connect FAILURE must not tear down the winner that replaced it", async () => {
    const rowV1 = integrationRow({ config: '{"v":1}' } as Partial<ChatIntegration>)
    const rowV2 = integrationRow({ config: '{"v":2}' } as Partial<ChatIntegration>)
    seedRow(rowV1)

    let rejectOldConnect: (e: Error) => void = () => {}
    const connOld = fakeConnector({
      connectImpl: () => new Promise<void>((_r, rej) => { rejectOldConnect = rej }),
    })
    const connNew = fakeConnector()
    let calls = 0
    vi.spyOn(mgr, 'createConnector').mockImplementation(async () => (++calls === 1 ? connOld : connNew))

    const tick = mgr.runHealthChecks()
    await settle()

    await mgr.removeIntegration(INT)
    seedRow(rowV2)
    await mgr.addIntegration(INT)

    rejectOldConnect(new Error('old credentials no longer valid'))
    await tick

    // The loser's failure cleanup must only touch what it owns.
    expect(mgr.connections.get(INT)?.connector).toBe(connNew)
    expect(connNew.disconnect).not.toHaveBeenCalled()
    expect(updateStatusMock).not.toHaveBeenCalledWith(INT, 'error', expect.anything())
  })

  it('stop() during the teardown await is not resurrected by the in-flight rebuild', async () => {
    seedRow(integrationRow())
    let releaseDisconnect: () => void = () => {}
    const dead = fakeConnector({
      disconnectImpl: () => new Promise<void>((r) => { releaseDisconnect = r }),
    })
    dead.connectedState = false
    mgr.connections.set(INT, { connector: dead } as never)
    mgr.disconnectedSince.set(INT, Date.now() - 10 * 60 * 1000)
    const createSpy = vi.spyOn(mgr, 'createConnector').mockResolvedValue(fakeConnector())

    const tick = mgr.runHealthChecks()
    await settle() // rebuild parked on the teardown await

    mgr.stop() // app shutdown (or web-server restart)
    releaseDisconnect()
    await tick

    // A stopped manager must stay stopped: no fresh connector, empty map.
    expect(createSpy).not.toHaveBeenCalled()
    expect(mgr.connections.size).toBe(0)
  })
})
