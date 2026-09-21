vi.mock('../../services/connection-sync-service', () => ({ syncRemoteMcpAgents: vi.fn(async () => true) }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationEvent } from '../../agent-integrations/types'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AppDatabase } from '../../db/drivers/types'
import { sql } from 'drizzle-orm'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../../db', () => ({ get db() { return testDb } }))
vi.mock('../../error-reporting', () => ({ captureException: vi.fn() }))
const outbound = vi.hoisted(() => ({ check: vi.fn(async () => true) }))
vi.mock('./mcp', () => ({ checkLinearMcp: outbound.check }))
const restored = vi.hoisted(() => ({ start: vi.fn(async () => {}), subscribe: vi.fn(async () => {}) }))
vi.mock('../../agent-actor', () => ({ agentRegistry: { get: () => ({
  container: { start: restored.start },
  sessions: { activity: () => 'idle', isStreamSubscribed: () => false, subscribeStream: restored.subscribe },
}) } }))
const transport = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), wake: (_id?: string) => {}, tracked: (_id: string): boolean => false }))
vi.mock('./subscriptions', () => ({ LinearSubscriptions: class {
  constructor(options: { onWake: (id?: string) => void; isTracked: (id: string) => boolean }) { transport.wake = options.onWake; transport.tracked = options.isTracked }
  start = transport.start
  stop = transport.stop
  isReady() { return true }
} }))
import { LinearAgentIntegration } from './linear-agent-integration'
import { createAgentIntegration, deleteAgentIntegration, getAgentIntegration } from '../../services/agent-integration-service'
import { getLinearConfig, updateLinearConfig } from './store'
import { DORMANT_ISSUE_POLL_MS, ISSUE_POLL_BATCH_SIZE, getIssueTracking } from './issue-cursor-store'
import { enqueueTaskEvent, pendingTaskEvents, taskEventHistory, updateTaskEvent } from '../store'
const at = '2026-09-01T00:00:00.000Z'
const issue = { id: 'issue', identifier: 'TES-1', title: 'Test', updatedAt: at, archivedAt: null, delegate: { id: 'app' }, state: { id: 'todo', name: 'Todo', type: 'unstarted' } }
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
class TestLinearIntegration extends LinearAgentIntegration { recover() { return this.recoverTasks() } }
let integration: TestLinearIntegration
let id: string
let events: IntegrationEvent[]
let fetchMock: ReturnType<typeof vi.fn<(url: string, options: { body: string }) => Promise<Response>>>
let notifications: unknown[]
let comments: unknown[]
let history: unknown[]
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-09-02T00:00:00Z'); vi.clearAllMocks(); outbound.check.mockReset().mockResolvedValue(true); transport.start.mockReset()
  handle = await createTestDatabase(); testDb = handle.db
  id = (await createAgentIntegration({ agentSlug: 'agent', provider: 'linear', config: {
    redirectUri: 'http://localhost/callback', clientId: 'client', clientSecret: 'secret', authorizedAt: Date.parse(at),
    identity: { workspaceId: 'workspace', workspaceName: 'Test', appUserId: 'app', appName: 'Agent' },
    tokens: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scope: 'read write app:mentionable app:assignable' },
  } }))
  integration = new TestLinearIntegration((await getAgentIntegration(id))!)
  events = []; integration.onEvent(event => { events.push(event) })
  notifications = [{ id: 'assignment', type: 'issueAssignedToYou', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, issue, comment: null }]
  comments = []; history = []
  fetchMock = vi.fn(async (_url, options) => {
    const { query, variables } = JSON.parse(options.body)
    if (query.includes('reactionCreate')) return Response.json({ data: { reactionCreate: { success: true } } })
    if (query.includes('viewer')) return Response.json({ data: { viewer: { id: 'app', name: 'Agent', displayName: 'Agent', app: true, avatarUrl: null, organization: { id: 'workspace', name: 'Test' } } } })
    if (query.includes('notifications(')) return Response.json({ data: { notifications: page(notifications) } })
    if (query.includes('comments(')) return Response.json({ data: { comments: page(comments) } })
    if (query.includes('issues(')) return Response.json({ data: { issues: page(variables.ids.map((id: string) => ({ ...issue, id }))) } })
    return Response.json({ data: { issue: { ...issue, id: variables.id, history: page(history) } } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => { await integration.disconnect(); await handle.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function connectAndSync() { await integration.connect(); await vi.advanceTimersByTimeAsync(0) }
describe('Linear integration lifecycle', () => {
  it('retains inbound work during an MCP outage and dispatches when discovery recovers', async () => {
    outbound.check.mockResolvedValue(false)
    await connectAndSync()
    expect(integration.isConnected()).toBe(true)
    expect((await pendingTaskEvents(id))[0].status).toBe('queued')
    expect(events.filter(event => event.type === 'input')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(outbound.check).toHaveBeenCalledTimes(2)
    outbound.check.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
    expect((await pendingTaskEvents(id))[0].status).toBe('running')
  })
  it('catches up before subscribing, then accepts gap events once and retains its cursor across restarts', async () => {
    transport.start.mockImplementation(() => { expect(events.filter(event => event.type === 'input')).toHaveLength(1) })
    await connectAndSync()
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect((await getLinearConfig(id)).syncedThrough).toBe('2026-09-01T23:59:00.000Z')
    comments = [{ id: 'reply', body: 'Follow-up', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', archivedAt: null, user: { id: 'human', app: false }, parent: { id: 'root' }, issue }]
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect((await pendingTaskEvents(id)).map(row => row.externalEventId)).toEqual(['assignment:assignment', 'comment:reply'])
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect(await pendingTaskEvents(id)).toHaveLength(2)
    const reactions = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body)).filter(request => request.query.includes('reactionCreate'))
    expect(reactions).toHaveLength(1)
    expect(reactions[0].variables).toEqual({ input: { commentId: 'reply', emoji: 'eyes' } })
    await integration.disconnect()
    expect(transport.stop).toHaveBeenCalled()
    const checkpoint = (await getLinearConfig(id)).syncedThrough
    await vi.advanceTimersByTimeAsync(300000)
    expect((await getLinearConfig(id)).syncedThrough).toBe(checkpoint)
  })
  it('accepts cancellation before starting recovered work and does not advance a failed batch', async () => {
    history = [{ id: 'stop', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, fromDelegate: { id: 'app' }, toDelegate: null, fromState: null, toState: null, archived: null }]
    await connectAndSync()
    expect(events.filter(event => event.type === 'input')).toHaveLength(0)
    expect((await taskEventHistory(id)).some(row => row.externalEventId.startsWith('stop:issue:'))).toBe(true)
    const checkpoint = (await getLinearConfig(id)).syncedThrough
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect((await getLinearConfig(id)).syncedThrough).toBe(checkpoint)
  })
  it('returns from connect before catch-up and retries a failed initial batch', async () => {
    const normal = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, options) => JSON.parse(options.body).query.includes('viewer')
      ? normal(url, options) : new Response(null, { status: 503 }))
    await integration.connect()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(integration.isConnected()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.start).not.toHaveBeenCalled()
    expect((await getLinearConfig(id)).syncedThrough).toBeUndefined()
    expect(events).toEqual([])
    fetchMock.mockImplementation(normal)
    await vi.advanceTimersByTimeAsync(4000)
    expect(integration.isConnected()).toBe(true)
    expect(transport.start).toHaveBeenCalledOnce()
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  })
  it('reports a sustained sync outage once, preserves its cursor, and recovers automatically', async () => {
    const errors = vi.fn(); integration.onError(errors)
    const normal = fetchMock.getMockImplementation()!
    await connectAndSync()
    const checkpoint = (await getLinearConfig(id)).syncedThrough
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect(errors).not.toHaveBeenCalled()
    expect(integration.isConnected()).toBe(true)
    await vi.advanceTimersByTimeAsync(180000)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0].message).toContain('Retrying automatically')
    expect(integration.isConnected()).toBe(false)
    expect((await getLinearConfig(id)).syncedThrough).toBe(checkpoint)
    fetchMock.mockImplementation(normal)
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect(integration.isConnected()).toBe(true)
    expect((await getLinearConfig(id)).syncedThrough).not.toBe(checkpoint)
    expect(errors).toHaveBeenCalledTimes(1)
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }))
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(13000)
    expect(errors).toHaveBeenCalledTimes(2)
  })
  it('stops polling on revoked authorization and requires reconnect instead of retrying forever', async () => {
    const errors = vi.fn(); integration.onError(errors)
    await connectAndSync()
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect(integration.isConnected()).toBe(false)
    expect((await getAgentIntegration(id))?.status).toBe('disconnected')
    expect((await getLinearConfig(id)).authorizationError).toContain('Reconnect')
    const calls = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
    expect(errors).not.toHaveBeenCalled()
  })

  it('stops timer work safely when its row disappears', async () => {
    await connectAndSync()
    await deleteAgentIntegration(id)
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect(integration.isConnected()).toBe(false)
    const calls = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })
  it('releases dispatch after a failed poll so accepted work can continue during backoff', async () => {
    await connectAndSync()
    await updateTaskEvent((await pendingTaskEvents(id))[0].id, { status: 'complete' })
    await enqueueTaskEvent(id, { id: 'queued', taskId: 'issue', interactionId: '', kind: 'invocation',
      timestamp: new Date().toISOString(), text: 'Continue accepted work', replyTarget: {}, payload: {} })
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    await integration.recover()
    expect(events.filter(event => event.type === 'input')).toHaveLength(2)
  })
  it('parks an inaccessible issue, ignores overlapping notifications, and rediscovers a new mention', async () => {
    await connectAndSync()
    const normal = fetchMock.getMockImplementation()!
    let removed = true
    fetchMock.mockImplementation(async (url, options) => JSON.parse(options.body).query.includes('issues(') && removed
      ? Response.json({ data: { issues: page([]) } }) : normal(url, options))
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    const rows = (await taskEventHistory(id)).length
    expect(await pendingTaskEvents(id)).toEqual([])
    const calls = fetchMock.mock.calls.length
    for (let tick = 0; tick < 5; tick++) { transport.wake(); await vi.advanceTimersByTimeAsync(250) }
    expect(await taskEventHistory(id)).toHaveLength(rows)
    expect(fetchMock.mock.calls.slice(calls).every(([, options]) => JSON.parse(options.body).query.includes('notifications('))).toBe(true)
    removed = false
    notifications = [{ id: 'new-mention', type: 'issueMention', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), actor: { id: 'human', app: false }, issue, comment: null }]
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    expect((await pendingTaskEvents(id)).map(row => row.externalEventId)).toEqual(['mention:new-mention'])
  })

  it('bounds routine polling for 1,000 handled issues and moves closed issues to slower checks', async () => {
    notifications = []
    const checkpoint = new Date(Date.now() - 60000).toISOString()
    await updateLinearConfig(id, config => ({ ...config, syncedThrough: checkpoint }))
    for (let index = 0; index < 1000; index++) {
      const taskId = `handled-${String(index).padStart(4, '0')}`
      await enqueueTaskEvent(id, { id: taskId, taskId, interactionId: '', kind: 'invocation', timestamp: at, text: 'Handled', replyTarget: {}, payload: {} })
    }
    await testDb.run(sql`UPDATE integration_task_events SET status = 'complete'`)
    const normal = fetchMock.getMockImplementation()!
    const batches: string[][] = []
    fetchMock.mockImplementation(async (url, options) => {
      const { query, variables } = JSON.parse(options.body)
      if (query.includes('issues(')) {
        batches.push(variables.ids)
        return Response.json({ data: { issues: page(variables.ids.map((id: string, index: number) => ({ ...issue, id,
          archivedAt: index % 2 ? at : null, state: { id: 'done', name: 'Done', type: 'completed' } }))) } })
      }
      if (query.includes('history(')) throw new Error('Unchanged history must not be fetched')
      return normal(url, options)
    })
    await connectAndSync()
    expect(fetchMock).toHaveBeenCalledTimes(4) // Identity plus notifications/comments/issues, independent of lifetime count.
    for (let pass = 0; pass < 39; pass++) {
      const before = fetchMock.mock.calls.length
      transport.wake(); await vi.advanceTimersByTimeAsync(250)
      expect(fetchMock.mock.calls.length - before).toBe(3)
    }
    expect(batches).toHaveLength(40)
    expect(batches.every(ids => ids.length <= ISSUE_POLL_BATCH_SIZE)).toBe(true)
    expect(new Set(batches.flat()).size).toBe(1000)
    const before = fetchMock.mock.calls.length
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(fetchMock.mock.calls.length - before).toBe(1) // All closed issues are now dormant.
    expect(events.filter(event => event.type === 'input')).toEqual([])
  })
  it('recovers an unmentioned thread reply after access returns, including across restart', async () => {
    notifications = [{ id: 'mention', type: 'issueCommentMention', createdAt: at, updatedAt: at, actor: { id: 'human', app: false }, issue,
      comment: { id: 'root', body: '@app please help', createdAt: at, updatedAt: at, archivedAt: null, user: { id: 'human', app: false }, parent: null } }]
    await connectAndSync()
    notifications = []
    const cursor = (await getIssueTracking(id, 'issue')).syncedThrough
    const normal = fetchMock.getMockImplementation()!
    let inaccessible = true
    fetchMock.mockImplementation(async (url, options) => {
      const { query } = JSON.parse(options.body)
      if (query.includes('issues(')) return Response.json({ data: { issues: page(inaccessible ? [] : [{ ...issue, delegate: null }]) } })
      return normal(url, options)
    })
    transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
    const rowCount = (await taskEventHistory(id)).length
    await vi.advanceTimersByTimeAsync(DORMANT_ISSUE_POLL_MS * 2)
    expect(await taskEventHistory(id)).toHaveLength(rowCount)
    expect((await getIssueTracking(id, 'issue')).syncedThrough).toBe(cursor)
    const replyAt = new Date(Date.now() - 1000).toISOString()
    comments = [{ id: 'unmentioned', body: 'Please also check this', createdAt: replyAt, updatedAt: replyAt, archivedAt: null,
      user: { id: 'human', app: false }, parent: { id: 'root' }, issue: { ...issue, delegate: null } }]
    await integration.disconnect()
    await vi.advanceTimersByTimeAsync(DORMANT_ISSUE_POLL_MS)
    inaccessible = false
    integration = new TestLinearIntegration((await getAgentIntegration(id))!)
    integration.onEvent(event => { events.push(event) })
    await connectAndSync()
    expect((await pendingTaskEvents(id)).map(row => row.externalEventId)).toEqual(['comment:unmentioned'])
    expect((await getIssueTracking(id, 'issue')).inaccessibleSince).toBeNull()
    expect(events.filter(event => event.type === 'input')).toHaveLength(2)
  })
  it('wakes within 250ms for a new issue discovered during an in-flight poll', async () => {
    await connectAndSync()
    const createdAt = new Date().toISOString()
    const other = { ...issue, id: 'new-issue', updatedAt: createdAt }
    notifications = [{ id: 'new-mention', type: 'issueCommentMention', createdAt, updatedAt: createdAt, actor: { id: 'human', app: false }, issue: other,
      comment: { id: 'new-root', body: '@app help', createdAt, updatedAt: createdAt, archivedAt: null, user: { id: 'human', app: false }, parent: null } }]
    const normal = fetchMock.getMockImplementation()!
    let awakened = false
    fetchMock.mockImplementation(async (url, options) => {
      const { query, variables } = JSON.parse(options.body)
      if (query.includes('reactionCreate') && variables.input.commentId === 'new-root' && !awakened) {
        awakened = true
        expect(transport.tracked('new-issue')).toBe(true)
        comments = [{ id: 'fast-followup', body: 'One more thing', createdAt, updatedAt: createdAt, archivedAt: null,
          user: { id: 'human', app: false }, parent: { id: 'new-root' }, issue: other }]
        transport.wake('new-issue')
      }
      return normal(url, options)
    })
    transport.wake(); await vi.advanceTimersByTimeAsync(250)
    expect(awakened).toBe(true)
    expect((await taskEventHistory(id)).some(row => row.externalEventId === 'comment:fast-followup')).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect((await taskEventHistory(id)).some(row => row.externalEventId === 'comment:fast-followup')).toBe(true)
  })

})

it.each(['cancel', 'archive', 'undelegate'])('does not stop a running turn for its own %s edit', async change => {
  await connectAndSync()
  const row = (await pendingTaskEvents(id))[0]
  await updateTaskEvent(row.id, { sessionId: 'sdk-issue' })
  const normal = fetchMock.getMockImplementation()!
  const now = new Date().toISOString()
  const current = { ...issue, updatedAt: now,
    ...(change === 'cancel' ? { state: { id: 'cancel', name: 'Canceled', type: 'canceled' } }
      : change === 'archive' ? { archivedAt: now } : { delegate: null }) }
  history = [{ id: 'self-edit', createdAt: now, updatedAt: now, actor: { id: 'app', app: true },
    fromDelegate: change === 'undelegate' ? { id: 'app' } : null, toDelegate: null,
    fromState: null, toState: change === 'cancel' ? current.state : null, archived: change === 'archive' }]
  fetchMock.mockImplementation(async (url, options) => JSON.parse(options.body).query.includes('issues(')
    ? Response.json({ data: { issues: page([current]) } }) : normal(url, options))
  transport.wake('issue'); await vi.advanceTimersByTimeAsync(250)
  expect((await pendingTaskEvents(id))[0].status).toBe('running')
  expect(events.filter(event => event.type === 'cancel')).toEqual([])
})

it.each([false, true])('waits for boot catch-up before restoring an existing session (externally stopped: %s)', async stopped => {
  notifications = []
  await enqueueTaskEvent(id, { id: 'old-request', taskId: 'issue', interactionId: 'issue', kind: 'invocation',
    timestamp: at, text: 'Existing request', replyTarget: {}, payload: {} })
  const row = (await pendingTaskEvents(id))[0]
  await updateTaskEvent(row.id, { status: 'running', sessionId: 'old-session' })
  if (stopped) history = [{ id: 'stop', createdAt: at, updatedAt: at, actor: { id: 'human', app: false },
    fromDelegate: { id: 'app' }, toDelegate: null, fromState: null, toState: null, archived: null }]
  await integration.connect()
  integration.observeSession({ integration: (await getAgentIntegration(id))!, externalId: 'issue', sessionId: 'old-session' })
  expect(restored.start).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(restored.start).toHaveBeenCalledTimes(stopped ? 0 : 1)
  expect(restored.subscribe).toHaveBeenCalledTimes(stopped ? 0 : 1)
})

it('stays healthy during a long first catch-up without dispatching or restoring sessions', async () => {
  let release!: (ready: boolean) => void
  outbound.check.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
  await enqueueTaskEvent(id, { id: 'old-request', taskId: 'old-issue', interactionId: 'old-issue', kind: 'invocation',
    timestamp: at, text: 'Existing request', replyTarget: {}, payload: {} })
  const row = (await pendingTaskEvents(id))[0]
  await updateTaskEvent(row.id, { status: 'running', sessionId: 'old-session' })
  await integration.connect()
  integration.observeSession({ integration: (await getAgentIntegration(id))!, externalId: 'old-issue', sessionId: 'old-session' })
  try {
    // Longer than the manager's five-minute disconnected grace period.
    await vi.advanceTimersByTimeAsync(11 * 60000)
    expect(integration.isConnected()).toBe(true)
    expect(outbound.check).toHaveBeenCalledOnce()
    expect(restored.start).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect((await pendingTaskEvents(id))[0].status).toBe('running')
    expect((await getLinearConfig(id)).syncedThrough).toBeUndefined()
  } finally { release(true); await vi.advanceTimersByTimeAsync(0) }
  expect(transport.start).toHaveBeenCalledOnce()
  expect(restored.start).toHaveBeenCalledOnce()
  expect(events.filter(event => event.type === 'input')).toHaveLength(1)
})
it('keeps old sessions deferred after a failed first sync until catch-up succeeds', async () => {
  await enqueueTaskEvent(id, { id: 'old-request', taskId: 'issue', interactionId: 'issue', kind: 'invocation',
    timestamp: at, text: 'Existing request', replyTarget: {}, payload: {} })
  const row = (await pendingTaskEvents(id))[0]
  await updateTaskEvent(row.id, { status: 'running', sessionId: 'old-session' })
  outbound.check.mockRejectedValueOnce(new Error('Temporary failure'))
  await connectAndSync()
  integration.observeSession({ integration: (await getAgentIntegration(id))!, externalId: 'issue', sessionId: 'old-session' })
  await integration.recover()
  expect(integration.isConnected()).toBe(true)
  expect(restored.start).not.toHaveBeenCalled()
  expect(events).toEqual([])
  await vi.advanceTimersByTimeAsync(4000)
  expect(restored.start).toHaveBeenCalledOnce()
})
