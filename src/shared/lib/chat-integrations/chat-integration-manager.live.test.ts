import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// LIVE manager-level validation: the reconcile/resume machinery driving a REAL
// SlackConnector against a real workspace. Gated: SLACK_LIVE=1 only.
//
//   SLACK_LIVE=1 SLACK_LIVE_CONFIG=/path/slack-config.json \
//   npx vitest run --disableConsoleIntercept \
//     src/shared/lib/chat-integrations/chat-integration-manager.live.test.ts
//
// The service layer is mocked (no real DB writes); the connector, socket, and
// Slack workspace are real. Validates the exact production failure paths:
//   1. ORPHAN RECOVERY (the Tomer bug): integration in the DB work list but
//      absent from the connections map → health tick rebuilds a live, connected
//      integration and clears the error badge,
//   2. MANAGER TAKEOVER: a dead socket past the grace window → tick tears down
//      and rebuilds a fresh connected connector,
//   3. RESUME: reconnectAll force-rebuilds a live connection (sleep-wake path)
//      and the rebuilt socket still receives real inbound events.
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
import type { ChatClientConnector, IncomingMessage } from './base-connector'
import type { ChatIntegration } from '@shared/lib/db/schema'

const LIVE = process.env.SLACK_LIVE === '1'
const INT = 'int-live-manager'

const listStartupMock = vi.mocked(listStartupChatIntegrations)
const getIntegrationMock = vi.mocked(getChatIntegration)
const updateStatusMock = vi.mocked(updateChatIntegrationStatus)

interface ManagerTestSurface {
  connections: Map<string, { connector: ChatClientConnector }>
  disconnectedSince: Map<string, number>
  consecutiveFailures: Map<string, number>
  reconcilingIds: Set<string>
  isRunning: boolean
  runHealthChecks(): Promise<void>
  reconnectAll(): Promise<void>
  enqueueMessage(integrationId: string, message: IncomingMessage): void
}

const mgr = chatIntegrationManager as unknown as ManagerTestSurface

function liveRow(status: 'active' | 'error'): ChatIntegration {
  const config = readFileSync(process.env.SLACK_LIVE_CONFIG!, 'utf8')
  return {
    id: INT,
    agentSlug: 'live-agent',
    provider: 'slack',
    name: 'Live Manager Test',
    status,
    requireApproval: true,
    sessionTimeout: null,
    createdByUserId: null,
    config,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as ChatIntegration
}

function connectorOf(id: string): ChatClientConnector | undefined {
  return mgr.connections.get(id)?.connector
}

function killRawSocket(connector: ChatClientConnector): void {
  const receiver = (connector as unknown as { receiver: { client: { websocket?: { websocket?: { terminate(): void } } } } }).receiver
  const raw = receiver?.client?.websocket?.websocket
  if (!raw) throw new Error('no raw websocket to terminate')
  raw.terminate()
}

async function waitFor(label: string, cond: () => boolean, timeoutMs: number, intervalMs = 200): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  console.log(`[live-mgr] ${label} after ${Date.now() - start}ms`)
}

describe.runIf(LIVE)('ChatIntegrationManager live reconcile against real Slack', () => {
  beforeAll(() => {
    mgr.isRunning = true
  })

  afterAll(async () => {
    const conn = connectorOf(INT)
    mgr.connections.delete(INT)
    await conn?.disconnect().catch(() => {})
    mgr.isRunning = false
  })

  it('ORPHAN RECOVERY: a health tick rebuilds an integration missing from the map and clears the badge', async () => {
    const row = liveRow('error') // orphaned integrations end up badged 'error'
    listStartupMock.mockReturnValue([row])
    getIntegrationMock.mockReturnValue(row)

    expect(mgr.connections.has(INT)).toBe(false)
    await mgr.runHealthChecks()

    const connector = connectorOf(INT)
    expect(connector).toBeTruthy()
    expect(connector!.isConnected()).toBe(true)
    expect(updateStatusMock).toHaveBeenCalledWith(INT, 'active', null)
    console.log('[live-mgr] orphan rebuilt into a live connected Slack integration')
  }, 60_000)

  it('MANAGER TAKEOVER: a dead socket past the grace window is torn down and rebuilt connected', async () => {
    const row = liveRow('active')
    listStartupMock.mockReturnValue([row])
    getIntegrationMock.mockReturnValue(row)

    const before = connectorOf(INT)!
    expect(before.isConnected()).toBe(true)

    // Kill the socket, then immediately claim the grace window already passed —
    // the tick must land in the window before the connector's own 1s-backoff
    // loop wins the race, so poll for the disconnect (detection is ~50ms).
    killRawSocket(before)
    await waitFor('socket drop visible to isConnected()', () => !before.isConnected(), 5_000, 20)
    mgr.disconnectedSince.set(INT, Date.now() - 10 * 60 * 1000)

    await mgr.runHealthChecks()

    const after = connectorOf(INT)!
    expect(after).toBeTruthy()
    expect(after).not.toBe(before) // genuinely rebuilt, not the old object
    await waitFor('rebuilt connector connected', () => after.isConnected(), 30_000)
  }, 90_000)

  it('RESUME: reconnectAll force-rebuilds and the fresh socket receives real inbound events', async () => {
    const row = liveRow('active')
    listStartupMock.mockReturnValue([row])
    getIntegrationMock.mockReturnValue(row)

    const before = connectorOf(INT)!
    const resume = mgr.reconnectAll()
    await waitFor('force rebuild swapped the connector', () => {
      const now = connectorOf(INT)
      return !!now && now !== before && now.isConnected()
    }, 60_000)
    await resume

    // End-to-end: a USER-authored message must reach the manager's inbound
    // queue through the rebuilt socket.
    const connectionIds = (process.env.SLACK_LIVE_CONNECTION_ID ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const nangoId = connectionIds.find((s) => s.startsWith('nango:'))
    if (!nangoId) {
      console.warn('[live-mgr] no nango: connection id — skipping inbound step')
      return
    }

    const inbound: IncomingMessage[] = []
    const enqueueSpy = vi.spyOn(mgr, 'enqueueMessage').mockImplementation((_id, msg) => {
      console.log(`[live-mgr] inbound reached manager queue: ${JSON.stringify(msg.text.slice(0, 60))}`)
      inbound.push(msg)
    })

    try {
      const { registerAllAccountProviders } = await import('@shared/lib/account-providers/register')
      const { getAccountProvider } = await import('@shared/lib/account-providers/provider-factory')
      registerAllAccountProviders()
      const nango = getAccountProvider('nango')

      const { WebClient } = await import('@slack/web-api')
      const cfg = JSON.parse(readFileSync(process.env.SLACK_LIVE_CONFIG!, 'utf8')) as { botToken: string }
      const botClient = new WebClient(cfg.botToken)
      const convos = await botClient.users.conversations({ types: 'public_channel,private_channel', limit: 100 })
      const channelId = convos.channels?.[0]?.id
      if (!channelId) throw new Error('bot is in no channels')

      const marker = `manager live ping ${Date.now()}`
      const payload = new TextEncoder().encode(JSON.stringify({ channel: channelId, text: marker }))
      const res = await nango.makeApiCall({
        providerConnectionId: nangoId.slice('nango:'.length),
        toolkitSlug: 'slack',
        targetUrl: 'https://slack.com/api/chat.postMessage',
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
        body: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!data.ok) throw new Error(`user-send failed: ${data.error}`)

      await waitFor('inbound user message in manager queue', () => inbound.some((m) => m.text.includes(marker)), 20_000)
    } finally {
      enqueueSpy.mockRestore()
    }
  }, 120_000)
})
