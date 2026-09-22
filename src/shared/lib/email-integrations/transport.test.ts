import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import { createAgentIntegration, getAgentIntegration } from '../services/agent-integration-service'
import { PlatformEmailAgentIntegration } from './platform-email-agent-integration'
import { emailConfigSchema, emailMessageSchema, emailThreadStateSchema } from './config-schema'
import { readEmailState, writeEmailState } from './state'
let handle: TestDatabase, testDb: AppDatabase
const transport = vi.hoisted(() => ({ json: vi.fn(), message: vi.fn(), unwatch: vi.fn(), watch: vi.fn() }))
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('./live', () => ({ watchEmail: transport.watch }))
vi.mock('./gateway-client', async importOriginal => ({ ...await importOriginal<typeof import('./gateway-client')>(), clientFor: () => transport }))
vi.mock('../services/platform-auth-service', () => ({ getPlatformAccessToken: () => 'test', getPlatformAuthStatus: () => ({ email: 'owner@example.com' }) }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
const config = emailConfigSchema.parse({ localPart: 'helper', displayName: 'Helper', mailboxId: '00000000-0000-4000-8000-000000000001', address: 'helper@company.ongamut.so', platformOrgId: 'org', platformMemberId: 'member' })
const message = emailMessageSchema.parse({ id: '00000000-0000-4000-8000-000000000002', mailboxId: config.mailboxId, threadId: 'canonical', direction: 'inbound', messageId: '<reply@example>', replyToMessageId: null, from: 'owner@example.com', to: [config.address], cc: [], bcc: [], replyTo: [], subject: 'Hello', text: 'Hi', html: null, status: 'received', createdAt: 20, authentication: { dmarc: 'pass' } })
let connector: PlatformEmailAgentIntegration, id: string
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks()
  handle = await createTestDatabase(); testDb = handle.db
  id = await createAgentIntegration({ agentSlug: 'agent', provider: 'platform-email', config })
  connector = new PlatformEmailAgentIntegration((await getAgentIntegration(id))!)
  transport.watch.mockReturnValue(transport.unwatch)
  transport.message.mockResolvedValue(message)
  transport.json.mockImplementation(async (path: string) => path === '/me' ? { orgId: 'org', memberId: 'member' } : path.startsWith('/events') ? { data: [], hasMore: false, cursor: 0 } : { status: 'active', domain: { status: 'ready' } })
})
afterEach(async () => { await connector.disconnect(); vi.useRealTimers(); await handle.close() })
it('resumes its persisted poll cursor, fetches full messages and checkpoints after handoff', async () => {
  await writeEmailState(id, 'cursor', z.number(), 10)
  transport.json.mockImplementation(async (path: string) => path === '/me' ? { orgId: 'org', memberId: 'member' } : path.startsWith('/events') ? { data: [{ cursor: 11, type: 'message.received', messageId: message.id }], hasMore: false, cursor: 11 } : { status: 'active', domain: { status: 'ready' } })
  const inputs = vi.fn(); connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  expect(transport.json).toHaveBeenCalledWith(expect.stringContaining('after=10'), expect.anything())
  expect(inputs).toHaveBeenCalledWith(expect.objectContaining({ payload: message, externalId: 'canonical' }))
  expect(await readEmailState(id, 'cursor', z.number())).toBe(11)
  await connector.disconnect()
  await vi.advanceTimersByTimeAsync(60000)
  expect(inputs).toHaveBeenCalledOnce()
  expect(transport.unwatch).toHaveBeenCalled()
})
it('retries after failed handoff without advancing the cursor', async () => {
  transport.json.mockImplementation(async (path: string) => path === '/me' ? { orgId: 'org', memberId: 'member' } : path.startsWith('/events') ? { data: [{ cursor: 1, type: 'message.received', messageId: message.id }], hasMore: false } : { status: 'active', domain: { status: 'ready' } })
  const inputs = vi.fn().mockRejectedValueOnce(new Error('handoff failed')).mockResolvedValue(undefined)
  connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  expect(await readEmailState(id, 'cursor', z.number())).toBe(null)
  await vi.advanceTimersByTimeAsync(30000)
  expect(await readEmailState(id, 'cursor', z.number())).toBe(1)
})
it('replays previously unaccepted replies after reconciliation and preserves an existing inbound route', async () => {
  await writeEmailState(id, 'thread:original', emailThreadStateSchema, { message: { ...message, threadId: 'original' }, contacted: false })
  transport.json.mockImplementation(async (path: string) => path === '/me' ? { orgId: 'org', memberId: 'member' } : path.startsWith('/events') ? { data: [{ cursor: 2, type: 'thread.reconciled', messageId: message.id, data: { fromThreadId: 'original', toThreadId: 'canonical' } }], hasMore: false } : { status: 'active', domain: { status: 'ready' } })
  const inputs = vi.fn(); connector.onEvent(inputs)
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  expect(inputs).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'original', payload: message }))
  await writeEmailState(id, `accepted:${message.id}`, z.boolean(), true)
  await vi.advanceTimersByTimeAsync(30000)
  expect(inputs).toHaveBeenCalledOnce()
})
it('waits for domain readiness before consuming email', async () => {
  transport.json.mockImplementation(async (path: string) => path === '/me' ? { orgId: 'org', memberId: 'member' } : { status: 'active', domain: { status: 'pending' } })
  await connector.connect(); await vi.advanceTimersByTimeAsync(0)
  expect(connector.isConnected()).toBe(false)
  expect(transport.json.mock.calls.some(([path]) => path.startsWith('/events'))).toBe(false)
})
it('rejects a changed Platform identity before subscribing', async () => {
  transport.json.mockResolvedValue({ orgId: 'different', memberId: 'member' })
  await expect(connector.connect()).rejects.toThrow('owns this inbox')
  expect(transport.watch).not.toHaveBeenCalled()
})
