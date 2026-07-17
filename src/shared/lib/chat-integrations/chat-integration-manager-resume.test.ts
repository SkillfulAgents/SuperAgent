import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// System-resume reconnect (powerMonitor 'resume' → reconnectAll).
//
// The old reconnectAll tore down and rebuilt each live connection with no
// overlap guard, no awaited teardown, and no failure handling beyond a log:
//   - a failed wake-time connect (network still down) removed the integration
//     from the map forever — the Tomer/ELECTRON-3T bug,
//   - overlapping resume events raced connect against stop (the bolt
//     "reading 'start'" null deref),
//   - fire-and-forget disconnect let the old socket fight the new one on
//     gateways that allow one connection per identity (iMessage code=4000).
//
// These tests assert the rebuilt behavior:
//   1. a wake-time failure is NOT an orphan — the next health tick recovers it,
//   2. concurrent reconnectAll calls coalesce into one pass,
//   3. the old connector's disconnect resolves before the new connect starts,
//   4. resume picks up integrations already orphaned before the wake,
//   5. an integration removed mid-connect is not resurrected (zombie guard),
//   6. after a failed force pass, quick follow-up retries run without waiting
//      for the 5-minute tick.
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
} from '@shared/lib/services/chat-integration-service'
import type { ChatClientConnector } from './base-connector'
import type { ChatIntegration } from '@shared/lib/db/schema'

const listStartupMock = vi.mocked(listStartupChatIntegrations)
const getIntegrationMock = vi.mocked(getChatIntegration)

interface ManagerTestSurface {
  connections: Map<string, { connector: ChatClientConnector }>
  chatSessions: Map<string, unknown>
  messageQueues: Map<string, unknown>
  disconnectedSince: Map<string, number>
  consecutiveFailures: Map<string, number>
  reconcilingIds: Set<string>
  isRunning: boolean
  reconnectAll(): Promise<void>
  runHealthChecks(): Promise<void>
  connectIntegration(integration: ChatIntegration): Promise<void>
  removeIntegration(id: string): Promise<void>
  createConnector(integration: unknown): Promise<ChatClientConnector>
}

const mgr = chatIntegrationManager as unknown as ManagerTestSurface

const INT = 'int-resume-test'

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
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetManagerState()
  mgr.isRunning = false
})

describe('resume: reconnectAll', () => {
  it('REGRESSION: wake-time connect failures do not orphan — the next tick recovers', async () => {
    vi.useFakeTimers()
    seedRow(integrationRow())
    const stale = fakeConnector()
    mgr.connections.set(INT, { connector: stale } as never)

    // Every resume attempt fails: the network stays down through the force
    // pass AND all quick follow-ups.
    const createSpy = vi.spyOn(mgr, 'createConnector').mockImplementation(async () =>
      fakeConnector({ connectImpl: async () => { throw new Error('wifi not up yet') } }))

    const resume = mgr.reconnectAll()
    await vi.advanceTimersByTimeAsync(150_000) // burn through all follow-up windows
    await resume

    expect(createSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(mgr.connections.has(INT)).toBe(false)

    // Network is back: the next regular health tick recovers it — this is the
    // exact scenario that used to be a permanent silent death.
    const working = fakeConnector()
    createSpy.mockResolvedValue(working)
    await mgr.runHealthChecks()
    expect(mgr.connections.get(INT)?.connector).toBe(working)
  })

  it('coalesces concurrent reconnectAll calls into serial passes, and the second wake still gets a FORCE pass', async () => {
    seedRow(integrationRow())
    let releaseConnect: () => void = () => {}
    let calls = 0
    const createSpy = vi.spyOn(mgr, 'createConnector').mockImplementation(async () => {
      calls++
      if (calls === 1) {
        return fakeConnector({
          connectImpl: () => new Promise<void>((resolve) => { releaseConnect = resolve }),
        })
      }
      return fakeConnector()
    })

    const first = mgr.reconnectAll()
    await new Promise((r) => setTimeout(r, 0))
    const second = mgr.reconnectAll()

    // Never concurrent: the second wake must not race a second teardown/rebuild
    // against the in-flight one (that race was the bolt "reading 'start'" null
    // deref).
    expect(createSpy).toHaveBeenCalledTimes(1)

    releaseConnect()
    await Promise.all([first, second])

    // …but it must not be silently swallowed either: after the first pass the
    // second wake's sockets are suspect again and isConnected() can read
    // stale-true, so exactly one more FORCE pass runs (rebuilding even
    // "connected" integrations).
    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(mgr.connections.has(INT)).toBe(true)
  })

  it('awaits the old connector\'s disconnect before starting the new connect', async () => {
    seedRow(integrationRow())
    const order: string[] = []

    const old = fakeConnector({
      disconnectImpl: async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('old-disconnect-resolved')
      },
    })
    mgr.connections.set(INT, { connector: old } as never)

    const fresh = fakeConnector({
      connectImpl: async () => { order.push('new-connect-started') },
    })
    vi.spyOn(mgr, 'createConnector').mockResolvedValue(fresh)

    await mgr.reconnectAll()

    expect(order).toEqual(['old-disconnect-resolved', 'new-connect-started'])
  })

  it('picks up integrations already orphaned before the wake', async () => {
    seedRow(integrationRow({ status: 'error' } as Partial<ChatIntegration>))
    const connector = fakeConnector()
    vi.spyOn(mgr, 'createConnector').mockResolvedValue(connector)

    await mgr.reconnectAll()

    expect(connector.connect).toHaveBeenCalledTimes(1)
    expect(mgr.connections.has(INT)).toBe(true)
  })

  it('zombie guard: an integration removed mid-connect is not resurrected', async () => {
    const row = integrationRow()
    seedRow(row)
    let releaseConnect: () => void = () => {}
    const hanging = fakeConnector({
      connectImpl: () => new Promise<void>((resolve) => { releaseConnect = resolve }),
    })
    vi.spyOn(mgr, 'createConnector').mockResolvedValue(hanging)

    const connecting = mgr.connectIntegration(row)
    await new Promise((r) => setTimeout(r, 0))

    // User removes/pauses while the connect is in flight.
    await mgr.removeIntegration(INT)
    expect(mgr.connections.has(INT)).toBe(false)

    releaseConnect()
    await connecting

    // The late-resolving connect must not re-register anything, and the
    // now-ownerless socket must be torn down.
    expect(mgr.connections.has(INT)).toBe(false)
    expect(hanging.disconnect).toHaveBeenCalled()
  })

  it('runs quick follow-up retries after a failed force pass instead of waiting for the tick', async () => {
    vi.useFakeTimers()
    seedRow(integrationRow())

    const failing = fakeConnector({ connectImpl: async () => { throw new Error('network still down') } })
    const working = fakeConnector()
    const createSpy = vi.spyOn(mgr, 'createConnector')
    createSpy.mockResolvedValueOnce(failing).mockResolvedValueOnce(working)

    const resume = mgr.reconnectAll()
    // Let the force pass fail, then advance into the first follow-up window.
    await vi.advanceTimersByTimeAsync(20_000)
    await resume

    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(mgr.connections.has(INT)).toBe(true)
    expect(mgr.connections.get(INT)?.connector).toBe(working)
  })
})
