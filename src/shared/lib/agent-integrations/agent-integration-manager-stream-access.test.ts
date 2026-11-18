/**
 * What one session event costs on its way to an integration, and when output
 * stops, against a real database: the manager reads the installation once per
 * event and its family decides from that row; text deltas ride on a check
 * their session passed less than a second ago. Access that ends while a reply
 * streams stops its text within that second and everything else at the next
 * event.
 */
vi.mock('./delivery-store', async () => ({ deliveryStore: (await import('./testing/memory-delivery-store')).memoryDeliveryStore() }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => true }))
vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({}),
}))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({ ensureRunning: vi.fn() }) }
})
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), addErrorBreadcrumb: vi.fn() }))

import { eq } from 'drizzle-orm'
import { agentIntegrationManager } from './agent-integration-manager'
import type { AgentIntegration } from './agent-integration'
import type { AgentIntegrationRecord, IntegrationOutput, IntegrationSessionContext } from './types'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'
import { createAgentIntegration, deleteAgentIntegration, getAgentIntegration, updateAgentIntegrationStatus } from '@shared/lib/services/agent-integration-service'
import { revokeChatAccess } from '@shared/lib/services/chat-integration-access-service'
import { MockChatAgentIntegration } from '../chat-integrations/mock-connector'
import { LinearAgentIntegration } from '../task-manager-integrations/linear/linear-agent-integration'
import { EmailAgentIntegration, emailDefinition } from '../email-integrations/email-agent-integration'
import { emailConfigSchema, emailMessageSchema } from '../email-integrations/config-schema'

const AGENT = 'agent-a'
const CHAT = 'chat-1'
const SESSION = 'session-1'

interface ManagedSession {
  connector: AgentIntegration
  integration: AgentIntegrationRecord
  chatId: string
  sessionId?: string
  context: IntegrationSessionContext
  sseUnsubscribe: (() => void) | null
}
const manager = agentIntegrationManager as unknown as {
  connections: Map<string, { connector: AgentIntegration; integration: AgentIntegrationRecord }>
  chatSessions: Map<string, ManagedSession>
  messageQueues: Map<string, Promise<void>>
  enqueueSSEEvent(integrationId: string, chatId: string, event: unknown, sessionId: string, observe?: ManagedSession): void
  releaseExternalSession(integrationId: string, externalId: string): Promise<void>
}

beforeEach(async () => {
  registerTasks(agentIntegrationManager)
  handle = await createTestDatabase()
  testDb = handle.db
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  manager.connections.clear()
  manager.chatSessions.clear()
  manager.messageQueues.clear()
  await handle.close()
})

/** A chat installation stored as the wizard leaves it; `requireApproval` only gates Telegram. */
async function chatInstallation(provider: 'slack' | 'telegram', requireApproval: boolean): Promise<AgentIntegrationRecord> {
  const id = `int-${provider}`
  await testDb.insert(schema.chatIntegrations).values({
    id, agentSlug: AGENT, provider, config: '{}', requireApproval, createdAt: new Date(0), updatedAt: new Date(0),
  }).run()
  return (await getAgentIntegration(id))!
}

async function chatAccess(integrationId: string, status: 'allowed' | 'denied'): Promise<string> {
  const id = `access-${integrationId}`
  await testDb.insert(schema.chatIntegrationAccess).values({
    id, integrationId, externalChatId: CHAT, chatType: 'private', status,
    requestedAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0),
  }).run()
  return id
}

async function linearInstallation(): Promise<AgentIntegrationRecord> {
  const id = await createAgentIntegration({ agentSlug: AGENT, provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'secret',
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' },
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000, scope: 'read write' },
  } })
  return (await getAgentIntegration(id))!
}

const emailConfig = emailConfigSchema.parse({
  localPart: 'helper', displayName: 'Agent', mailboxId: '00000000-0000-4000-8000-000000000001',
  address: 'helper@company.example', platformOrgId: 'org-1', platformMemberId: 'member-1',
})
const inboundMail = emailMessageSchema.parse({
  id: '00000000-0000-4000-8000-000000000002', mailboxId: emailConfig.mailboxId, threadId: CHAT, direction: 'inbound',
  messageId: '<in@example>', replyToMessageId: null, from: 'owner@company.example', to: [emailConfig.address], cc: [], bcc: [],
  replyTo: [], subject: 'Hello', text: 'Hello there', html: null, status: 'received', createdAt: 20, authentication: { dmarc: 'pass' },
})
class FakeEmail extends EmailAgentIntegration {
  readonly provider = 'platform-email'
  readonly definition = emailDefinition
  isAvailable = async () => true
  connect = async () => {}
  disconnect = async () => {}
  isConnected = () => true
  getMessage = async () => inboundMail
  getThread = async () => [inboundMail]
  recentHistory = async () => ({ threads: [[inboundMail]], truncated: false })
  downloadAttachment = async () => Buffer.from('file')
  uploadAttachment = async () => '00000000-0000-4000-8000-000000000004'
  submit = async () => inboundMail
}
async function emailInstallation(): Promise<AgentIntegrationRecord> {
  // The sender is one of the agent's people: what the default access level admits.
  await testDb.insert(schema.user).values({ id: 'owner', name: 'Owner', email: 'owner@company.example', emailVerified: true, role: 'admin' }).run()
  const id = await createAgentIntegration({ agentSlug: AGENT, provider: 'platform-email', config: emailConfig })
  return (await getAgentIntegration(id))!
}

/** A connected installation with one chat following `SESSION`; `delivered` is what reached its connector. */
function follow(connector: AgentIntegration, integration: AgentIntegrationRecord) {
  const delivered: IntegrationOutput[] = []
  vi.spyOn(connector, 'deliver').mockImplementation(async (_context, output) => { delivered.push(output) })
  const session: ManagedSession = {
    connector, integration, chatId: CHAT, sessionId: SESSION, sseUnsubscribe: null,
    context: { integration, externalId: CHAT, sessionId: SESSION },
  }
  manager.connections.set(integration.id, { connector, integration })
  manager.chatSessions.set(`${integration.id}:${CHAT}`, session)
  /** One session event through the chat's queue; resolves to the statements it ran. */
  const emit = async (event: Record<string, unknown>, sessionId = SESSION): Promise<number> => {
    // drizzle's session is where every builder and raw statement is prepared, on
    // both drivers; it has no public hook, so the test reaches for it by name.
    const prepared = vi.spyOn((testDb as unknown as { session: { prepareQuery(...args: unknown[]): unknown } }).session, 'prepareQuery')
    manager.enqueueSSEEvent(integration.id, CHAT, event, sessionId, session)
    await manager.messageQueues.get(`sse:${integration.id}:${CHAT}`)
    const statements = prepared.mock.calls.length
    prepared.mockRestore()
    return statements
  }
  return { delivered, emit, session }
}

const delta = { type: 'stream_delta', text: 'hello' }
const idle = { type: 'session_idle' }

describe('statements per session event', () => {
  it('reads a Slack-like installation once', async () => {
    const integration = await chatInstallation('slack', true)
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)

    expect(await emit(idle)).toBe(1)
    expect(delivered).toEqual([{ type: 'turn-completed', event: idle }])
  })

  it('reads a Telegram installation that requires approval once, and its chat once', async () => {
    const integration = await chatInstallation('telegram', true)
    await chatAccess(integration.id, 'allowed')
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)

    expect(await emit(idle)).toBe(2)
    expect(delivered).toHaveLength(1)
  })

  it('reads a public Telegram installation once', async () => {
    const integration = await chatInstallation('telegram', false)
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)

    expect(await emit(idle)).toBe(1)
    expect(delivered).toHaveLength(1)
  })

  it('reads a Linear installation once', async () => {
    const integration = await linearInstallation()
    const { delivered, emit } = follow(new LinearAgentIntegration(integration), integration)

    expect(await emit(idle)).toBe(1)
    expect(delivered).toHaveLength(1)
  })

  it('reads an email installation once, and the agent\'s people once', async () => {
    const integration = await emailInstallation()
    const { delivered, emit } = follow(new FakeEmail(integration), integration)

    expect(await emit(idle)).toBe(2)
    expect(delivered).toHaveLength(1)
  })

  it('delivers with the installation as it is stored now, not as the session first saw it', async () => {
    const integration = await chatInstallation('slack', true)
    const connector = new MockChatAgentIntegration()
    const { emit } = follow(connector, integration)
    await testDb.update(schema.chatIntegrations).set({ name: 'Renamed' }).where(eq(schema.chatIntegrations.id, integration.id)).run()

    await emit(idle)

    expect(vi.mocked(connector.deliver).mock.calls[0][0].integration.name).toBe('Renamed')
  })

  it('reads nothing for an event of a session the chat no longer follows', async () => {
    const integration = await chatInstallation('slack', true)
    const { delivered, emit, session } = follow(new MockChatAgentIntegration(), integration)
    session.sessionId = 'session-2'

    expect(await emit(idle)).toBe(0)
    expect(delivered).toEqual([])
  })
})

describe('access that ends while a reply streams', () => {
  it('stops at the next event when the installation is deleted', async () => {
    const integration = await chatInstallation('slack', true)
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)
    await emit(delta)
    expect(delivered).toHaveLength(1)

    await deleteAgentIntegration(integration.id)
    await emit(idle)

    expect(delivered).toHaveLength(1)
  })

  it('stops at the next event when a Telegram chat is revoked', async () => {
    const integration = await chatInstallation('telegram', true)
    const access = await chatAccess(integration.id, 'allowed')
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)
    await emit(delta)
    expect(delivered).toHaveLength(1)

    expect(await revokeChatAccess(access, 'owner')).toBe(true)
    await emit(idle)

    expect(delivered).toHaveLength(1)
  })

  it('stops at the next event when a public Telegram installation starts requiring approval', async () => {
    const integration = await chatInstallation('telegram', false)
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)
    await emit(delta)
    expect(delivered).toHaveLength(1)

    await testDb.update(schema.chatIntegrations).set({ requireApproval: true }).where(eq(schema.chatIntegrations.id, integration.id)).run()
    await emit(idle)

    expect(delivered).toHaveLength(1)
  })

  it('stops at the next event when a Linear installation is paused', async () => {
    const integration = await linearInstallation()
    const { delivered, emit } = follow(new LinearAgentIntegration(integration), integration)
    await emit(delta)
    expect(delivered).toHaveLength(1)

    await updateAgentIntegrationStatus(integration.id, 'paused')
    await emit(idle)

    expect(delivered).toHaveLength(1)
  })

  it('stops at the next event when an email installation is paused', async () => {
    const integration = await emailInstallation()
    const { delivered, emit } = follow(new FakeEmail(integration), integration)
    await emit(delta)
    expect(delivered).toHaveLength(1)

    await updateAgentIntegrationStatus(integration.id, 'paused')
    await emit(idle)

    expect(delivered).toHaveLength(1)
  })

  it('reads nothing once the revoked chat\'s session is released', async () => {
    const integration = await chatInstallation('telegram', true)
    const access = await chatAccess(integration.id, 'allowed')
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)
    await testDb.insert(schema.chatIntegrationSessions).values({
      id: 'mapping', integrationId: integration.id, externalChatId: CHAT, sessionId: SESSION, createdAt: new Date(0), updatedAt: new Date(0),
    }).run()
    await emit(delta)

    await revokeChatAccess(access, 'owner')
    await manager.releaseExternalSession(integration.id, CHAT)

    expect(await emit(delta)).toBe(0)
    expect(delivered).toHaveLength(1)
  })
})

describe('text deltas behind a check their session passed', () => {
  const START = 1_700_000_000_000
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(START)
  })

  it('read nothing for a second, then read once again', async () => {
    const integration = await chatInstallation('slack', true)
    const { delivered, emit } = follow(new MockChatAgentIntegration(), integration)

    expect(await emit(delta)).toBe(1)
    expect(await emit(delta)).toBe(0)
    vi.setSystemTime(START + 999)
    expect(await emit(delta)).toBe(0)
    vi.setSystemTime(START + 1_000)
    expect(await emit(delta)).toBe(1)
    expect(await emit(delta)).toBe(0)
    expect(delivered).toHaveLength(5)
  })

  it.each([
    ['Slack-like', () => chatInstallation('slack', true), () => new MockChatAgentIntegration(), 1],
    ['Telegram with approval', async () => { const made = await chatInstallation('telegram', true); await chatAccess(made.id, 'allowed'); return made }, () => new MockChatAgentIntegration(), 2],
    ['Linear', linearInstallation, (made: AgentIntegrationRecord) => new LinearAgentIntegration(made), 1],
    ['email', emailInstallation, (made: AgentIntegrationRecord) => new FakeEmail(made), 2],
  ] as const)('a %s reply of 300 deltas over three seconds checks access three times', async (_family, install, connect, perCheck) => {
    const integration = await install()
    const { delivered, emit } = follow(connect(integration), integration)

    let statements = 0
    for (let sent = 0; sent < 300; sent++) {
      vi.setSystemTime(START + sent * 10)
      statements += await emit(delta)
    }

    expect(statements).toBe(3 * perCheck)
    expect(delivered).toHaveLength(300)
  })

  it('does not stand for any other event', async () => {
    const integration = await chatInstallation('slack', true)
    const { emit } = follow(new MockChatAgentIntegration(), integration)
    await emit(delta)

    for (const type of ['stream_start', 'tool_use_ready', 'user_request_created', 'turn_output_complete', 'session_idle', 'session_error']) {
      expect(await emit({ type }), type).toBe(1)
    }
  })

  it('does not stand for another session the chat follows next', async () => {
    const integration = await chatInstallation('slack', true)
    const { emit, session } = follow(new MockChatAgentIntegration(), integration)
    await emit(delta)

    session.sessionId = 'session-2'

    expect(await emit(delta, 'session-2')).toBe(1)
  })

  it('does not outlive the live session', async () => {
    const integration = await chatInstallation('slack', true)
    const connector = new MockChatAgentIntegration()
    await follow(connector, integration).emit(delta)

    // A teardown and a new subscription leave a new live session for the same chat.
    expect(await follow(connector, integration).emit(delta)).toBe(1)
  })

  const endings = [
    ['a deleted Slack-like installation', () => chatInstallation('slack', true), () => new MockChatAgentIntegration(),
      (made: AgentIntegrationRecord) => deleteAgentIntegration(made.id)],
    ['a revoked Telegram chat', async () => { const made = await chatInstallation('telegram', true); await chatAccess(made.id, 'allowed'); return made }, () => new MockChatAgentIntegration(),
      (made: AgentIntegrationRecord) => revokeChatAccess(`access-${made.id}`, 'owner')],
    ['a paused Linear installation', linearInstallation, (made: AgentIntegrationRecord) => new LinearAgentIntegration(made),
      (made: AgentIntegrationRecord) => updateAgentIntegrationStatus(made.id, 'paused')],
    ['a paused email installation', emailInstallation, (made: AgentIntegrationRecord) => new FakeEmail(made),
      (made: AgentIntegrationRecord) => updateAgentIntegrationStatus(made.id, 'paused')],
  ] as const

  // The write is all that happens here: no teardown follows it, as when another process made it.
  it.each(endings)('%s stops streamed text within a second', async (_what, install, connect, end) => {
    const integration = await install()
    const { delivered, emit } = follow(connect(integration), integration)
    await emit(delta)
    expect(delivered).toHaveLength(1)

    vi.setSystemTime(START + 100)
    await end(integration)
    // Inside the bound, the text still rides on the check made before the write.
    vi.setSystemTime(START + 999)
    expect(await emit(delta)).toBe(0)
    expect(delivered).toHaveLength(2)

    vi.setSystemTime(START + 1_000)
    await emit(delta)
    // A refused check stands for nothing: the next delta is checked again.
    expect(await emit(delta)).toBeGreaterThan(0)
    expect(delivered).toHaveLength(2)
  })

  it.each(endings)('%s stops any other event at once', async (_what, install, connect, end) => {
    const integration = await install()
    const { delivered, emit } = follow(connect(integration), integration)
    await emit(delta)

    await end(integration)
    await emit({ type: 'stream_start' })
    await emit(idle)
    // The refused check also ended what the deltas rode on.
    await emit(delta)

    expect(delivered).toHaveLength(1)
  })
})
