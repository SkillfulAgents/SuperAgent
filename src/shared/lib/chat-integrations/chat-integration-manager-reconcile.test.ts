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
  isRunning: boolean
  runHealthChecks(): Promise<void>
  createConnector(integration: unknown): Promise<ChatClientConnector>
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

function fakeConnector(opts?: { connectImpl?: () => Promise<void> }): FakeConnector {
  const c = {
    provider: 'telegram',
    connectedState: true,
    connect: vi.fn(opts?.connectImpl ?? (async () => {})),
    disconnect: vi.fn(async () => {}),
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
