import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../db/schema'
import type { IntegrationEvent } from '../../agent-integrations/types'
let sqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle>
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('../attachments', async importOriginal => ({ ...await importOriginal<typeof import('../attachments')>(), pruneTaskAttachments: vi.fn(async () => {}) }))
vi.mock('../../agent-actor', () => ({ agentRegistry: { get: () => ({ sessions: { activity: () => 'idle' } }) } }))
const transport = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), wake: () => {} }))
vi.mock('./subscriptions', () => ({ LinearSubscriptions: class {
  constructor(options: { onWake: () => void }) { transport.wake = options.onWake }
  start = transport.start
  stop = transport.stop
  isReady() { return true }
} }))
import { LinearAgentIntegration } from './linear-agent-integration'
import { createChatIntegration, getChatIntegration } from '../../services/chat-integration-service'
import { getLinearConfig } from './store'
import { pendingTaskEvents, taskEventHistory } from '../store'
const at = '2026-09-01T00:00:00.000Z'
const issue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: at, archivedAt: null, delegate: { id: 'app' }, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
let integration: LinearAgentIntegration
let id: string
let events: IntegrationEvent[]
let fetchMock: ReturnType<typeof vi.fn<(url: string, options: { body: string }) => Promise<Response>>>
let notifications: unknown[]
let comments: unknown[]
let history: unknown[]
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime('2026-09-02T00:00:00Z'); vi.clearAllMocks(); transport.start.mockReset()
  sqlite = new Database(':memory:'); testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  id = createChatIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'secret', authorizedAt: Date.parse(at),
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' },
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } })
  integration = new LinearAgentIntegration(getChatIntegration(id)!)
  events = []; integration.onEvent(event => { events.push(event) })
  notifications = [{ id: 'assignment', type: 'issueAssignedToYou', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, issue, comment: null }]
  comments = []; history = []
  fetchMock = vi.fn(async (_url, options) => {
    const { query } = JSON.parse(options.body)
    if (query.includes('reactionCreate')) return Response.json({ data: { reactionCreate: { success: true } } })
    if (query.includes('viewer')) return Response.json({ data: { viewer: { id: 'app', name: 'Agent', displayName: 'Agent', app: true, avatarUrl: null, organization: { id: 'workspace', name: 'Test' } } } })
    if (query.includes('notifications(')) return Response.json({ data: { notifications: page(notifications) } })
    if (query.includes('comments(')) return Response.json({ data: { comments: page(comments) } })
    if (query.includes('issues(')) return Response.json({ data: { issues: page([issue]) } })
    return Response.json({ data: { issue: { ...issue, history: page(history) } } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { await integration.disconnect(); sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('Linear integration lifecycle', () => {
  it('catches up before subscribing, then accepts gap events once and retains its cursor across restarts', async () => {
    transport.start.mockImplementation(() => { expect(events.filter(event => event.type === 'input')).toHaveLength(1) })
    await integration.connect()
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(getLinearConfig(id).syncedThrough).toBe('2026-09-01T23:59:00.000Z')
    comments = [{ id: 'reply', body: 'Follow-up', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', archivedAt: null, user: { id: 'human', app: false }, parent: { id: 'root' }, issue }]
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(pendingTaskEvents(id).map(row => row.externalEventId)).toEqual(['assignment:assignment', 'comment:reply'])
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(pendingTaskEvents(id)).toHaveLength(2)
    const reactions = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body)).filter(request => request.query.includes('reactionCreate'))
    expect(reactions).toHaveLength(1)
    expect(reactions[0].variables).toEqual({ input: { commentId: 'reply', emoji: 'eyes' } })
    await integration.disconnect()
    expect(transport.stop).toHaveBeenCalled()
    const checkpoint = getLinearConfig(id).syncedThrough
    await vi.advanceTimersByTimeAsync(300000)
    expect(getLinearConfig(id).syncedThrough).toBe(checkpoint)
  })
  it('accepts cancellation before starting recovered work and does not advance a failed batch', async () => {
    history = [{ id: 'stop', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, fromDelegate: { id: 'app' }, toDelegate: null, fromState: null, toState: null, archived: null }]
    await integration.connect()
    expect(events.filter(event => event.type === 'input')).toHaveLength(0)
    expect(taskEventHistory(id).some(row => row.externalEventId.startsWith('stop:issue:'))).toBe(true)
    const checkpoint = getLinearConfig(id).syncedThrough
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(getLinearConfig(id).syncedThrough).toBe(checkpoint)
  })
  it('fails connection setup when the initial recovery batch cannot be read', async () => {
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, options) => JSON.parse(options.body).query.includes('viewer')
      ? normal(url, options) : new Response(null, { status: 503 }))
    await expect(integration.connect()).rejects.toThrow('503')
    expect(integration.isConnected()).toBe(false)
    expect(transport.start).not.toHaveBeenCalled()
    expect(getLinearConfig(id).syncedThrough).toBeUndefined()
    expect(events).toEqual([])
  })
  it('reports a sustained sync outage once, preserves its cursor, and recovers automatically', async () => {
    const errors = vi.fn(); integration.onError(errors)
    const normal = fetchMock.getMockImplementation()!
    await integration.connect()
    const checkpoint = getLinearConfig(id).syncedThrough
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(errors).not.toHaveBeenCalled()
    expect(integration.isConnected()).toBe(true)
    await vi.advanceTimersByTimeAsync(180000)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0].message).toContain('Retrying automatically')
    expect(integration.isConnected()).toBe(false)
    expect(getLinearConfig(id).syncedThrough).toBe(checkpoint)
    fetchMock.mockImplementation(normal)
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(integration.isConnected()).toBe(true)
    expect(getLinearConfig(id).syncedThrough).not.toBe(checkpoint)
    expect(errors).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }))
    transport.wake(); await vi.advanceTimersByTimeAsync(13000)
    expect(errors).toHaveBeenCalledTimes(2)
  })
  it('stops polling on revoked authorization and requires reconnect instead of retrying forever', async () => {
    const errors = vi.fn(); integration.onError(errors)
    await integration.connect()
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(integration.isConnected()).toBe(false)
    expect(getChatIntegration(id)?.status).toBe('disconnected')
    expect(getLinearConfig(id).authorizationError).toContain('Reconnect')
    const calls = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
    expect(errors).not.toHaveBeenCalled()
  })

})
