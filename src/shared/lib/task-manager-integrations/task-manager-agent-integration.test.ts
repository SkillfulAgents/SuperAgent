import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'
import type { AgentIntegrationRecord, IntegrationEvent, IntegrationInputContext, IntegrationSessionContext } from '../agent-integrations/types'
import { captureException } from '../error-reporting'
import { taskFailureNoticeSchema } from './schemas'
import { pendingUserInputRequestSchema } from '../user-input/request-schema'
import type { TaskEvent, TaskSnapshot } from './types'
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
import { TaskManagerAgentIntegration } from './task-manager-agent-integration'
import { getIntegrationSession } from '../agent-integrations/store'
import { createAgentIntegration, getAgentIntegration } from '../services/agent-integration-service'
import { getTaskEvent, pendingTaskEvents, updateTaskEvent, updateActiveTaskEvent, enqueueTaskEvent, wasStopped, claimTaskFailureNotice } from './store'
const snapshot: TaskSnapshot = { id: 'issue', identifier: 'SUP-1', title: 'Work', description: 'Description', url: 'https://linear.app/issue', updatedAt: 'now', properties: {}, comments: [], attachments: [], truncated: false }
class FakeTasks extends TaskManagerAgentIntegration {
  readonly provider = 'fake'
  readonly definition = { provider: 'fake', name: 'Fake', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  acknowledged: TaskEvent[] = []
  failAcknowledgement = false
  publishFailure = vi.fn(async (_event: TaskEvent, _notice: { id: string; body: string }) => {})
  constructor(row: AgentIntegrationRecord) { super(row) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false; this.stopTaskRetries() }
  protected async acknowledgeTask(event: TaskEvent) { this.acknowledged.push(event); if (this.failAcknowledgement) throw new Error('Reaction failed') }
  protected async hydrateTask() { return snapshot }
  protected taskGuidance() { return 'Use your own MCP identity to reply. Final text is not automatically posted.' }
  accept(event: TaskEvent) { return this.acceptTaskEvent(event) }
  stop(taskId: string, timestamp?: string) { return this.stopTask(taskId, undefined, timestamp) }
  recover() { return this.recoverTasks() }
}
function bindHost(tasks: FakeTasks) {
  tasks.bindHost({ session: async externalId => {
    const session = await getIntegrationSession(integration.id, externalId)
    return session ? { integration, externalId, sessionId: session.sessionId, activity: 'idle' } : undefined
  } })
}
let integration: AgentIntegrationRecord
let tasks: FakeTasks
let events: IntegrationEvent[]
function event(id: string, taskId = 'issue'): TaskEvent { return { id, taskId, interactionId: taskId, kind: 'invocation', sourceCommentId: id, timestamp: new Date().toISOString(), text: 'Do work', replyTarget: { commentId: 'root' }, payload: {} } }
function context(index = 0): IntegrationSessionContext {
  const input = events.filter(event => event.type === 'input')[index]
  if (input.type !== 'input') throw new Error('Missing input')
  return { integration, ...tasks.resolveRoute(input), sessionId: `sdk-${input.externalId}` }
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-09-02T00:00:00Z')
  handle = await createTestDatabase(); testDb = handle.db
  const id = await createAgentIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'test' } })
  integration = (await getAgentIntegration(id))!
  tasks = new FakeTasks(integration); events = []
  tasks.onEvent(event => { events.push(event) })
  bindHost(tasks)
  await tasks.connect()
})
afterEach(async () => { await tasks.disconnect(); await handle.close(); vi.restoreAllMocks(); vi.useRealTimers() })
describe('TaskManagerAgentIntegration with MCP outbound', () => {
  it('acknowledges durable requests once while preserving per-issue ordering', async () => {
    await tasks.accept(event('one')); await tasks.accept(event('two')); await tasks.accept(event('one'))
    await tasks.accept({ ...event('context'), kind: 'context' }); await tasks.accept(event('other', 'other'))
    expect(tasks.acknowledged.map(event => event.id)).toEqual(['one', 'two', 'other'])
    expect(events.filter(event => event.type === 'input')).toHaveLength(2)
    const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(events.filter(event => event.type === 'input')).toHaveLength(3)
  })
  it('continues after an acknowledgement failure and hydrates each invocation', async () => {
    tasks.failAcknowledgement = true
    await tasks.accept(event('one'))
    const input = events.find(event => event.type === 'input')!
    const prepared = await tasks.prepareInput(input, context() as IntegrationInputContext)
    expect(prepared.text).toContain('Description')
    expect(prepared.systemPrompt).toContain('MCP identity')
    expect(tasks.sessionPolicy(integration, tasks.resolveRoute(input)).timeoutHours).toBeNull()
  })
  it('completes without a publication draft, transcript copy, or custom outbound tools', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'Already posted through MCP' } })
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'complete', publicationJson: null, responseText: null })
    expect(tasks.getTools(ctx)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not associate an unrelated permission review with the task and resumes the matching request', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    const request = pendingUserInputRequestSchema.parse({ id: 'review', kind: 'proxy_review', scope: { agentSlug: 'agent', sessionId: 'other' }, blocking: true, payload: {} })
    await tasks.deliver(ctx, { type: 'request-opened', request })
    expect((await getTaskEvent(ctx.replyTarget!.eventId))?.status).toBe('running')
    await tasks.deliver(ctx, { type: 'request-opened', request: { ...request, scope: { agentSlug: 'agent', sessionId: ctx.sessionId } } })
    await tasks.deliver(ctx, { type: 'request-resolved', requestId: 'other', kind: 'question', outcome: 'answered', scope: { agentSlug: 'agent', sessionId: ctx.sessionId } })
    expect((await getTaskEvent(ctx.replyTarget!.eventId))?.status).toBe('awaiting_input')
    await tasks.deliver(ctx, { type: 'request-resolved', requestId: 'review', kind: 'question', outcome: 'answered', scope: { agentSlug: 'agent', sessionId: ctx.sessionId } })
    expect((await getTaskEvent(ctx.replyTarget!.eventId))?.status).toBe('running')
  })
  it('fences late completion after cancellation and never acknowledges an unconfirmed interrupt', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.stop('issue')
    await updateActiveTaskEvent(ctx.replyTarget!.eventId, { status: 'awaiting_input', inputRequestJson: '{"id":"late-review"}' })
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect((await getTaskEvent(ctx.replyTarget!.eventId))?.status).toBe('cancelled')
    expect(events.filter(event => event.type === 'cancel')).toHaveLength(1)
    expect(await pendingTaskEvents(integration.id)).toEqual([])
  })
  it('retires a legacy publication draft without posting or re-executing it', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await updateTaskEvent(ctx.replyTarget!.eventId, { status: 'responding', publicationJson: '{"body":"old draft"}' })
    await tasks.recover()
    expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'failed', publicationJson: null })
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  })
})

it('keeps unrelated issue comments queued while a native question awaits its answer in Gamut', async () => {
  await tasks.accept(event('one')); const ctx = context()
  await tasks.deliver(ctx, { type: 'turn-started' })
  const request = pendingUserInputRequestSchema.parse({ id: 'question', kind: 'question', scope: { agentSlug: 'agent', sessionId: ctx.sessionId },
    blocking: true, payload: { questions: [{ question: 'Which release?', multiSelect: false }] } })
  await tasks.deliver(ctx, { type: 'request-opened', request })
  await tasks.accept({ ...event('unrelated'), text: 'Different topic', replyTarget: { commentId: 'other-thread' } })
  expect(events.filter(event => event.type === 'response')).toEqual([])
  expect((await pendingTaskEvents(integration.id)).map(row => row.status)).toEqual(['awaiting_input', 'queued'])
  await tasks.deliver(ctx, { type: 'request-resolved', requestId: 'question', kind: 'question', outcome: 'answered', scope: { agentSlug: 'agent', sessionId: ctx.sessionId } })
  await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
  expect(events.filter(event => event.type === 'input')).toHaveLength(2)
})
it('retries pre-execution startup failures with backoff, then durably publishes one failure notice', async () => {
  await tasks.accept(event('one')); const ctx = context()
  const failure = { type: 'message' as const, inputId: ctx.replyTarget!.eventId, retryable: true, text: 'Unable to start. Please try again.' }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 3) tasks.publishFailure.mockRejectedValueOnce(new Error('Linear offline'))
    await tasks.deliver({ integration, externalId: 'issue' }, failure)
    expect(await getTaskEvent(failure.inputId)).toMatchObject({ dispatchAttempts: attempt, status: attempt < 3 ? 'queued' : 'responding' })
    if (attempt < 3) {
      await tasks.accept(event(`later-${attempt}`))
      await tasks.recover()
      expect(events.filter(event => event.type === 'input')).toHaveLength(attempt)
      await vi.advanceTimersByTimeAsync(30000 * attempt)
      await tasks.recover()
      expect(events.filter(event => event.type === 'input')).toHaveLength(attempt + 1)
    }
  }
  expect(tasks.acknowledged.filter(event => event.id === 'one')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(30000)
  await tasks.recover()
  expect(await getTaskEvent(failure.inputId)).toMatchObject({ status: 'failed', publicationJson: null })
  expect(tasks.publishFailure).toHaveBeenCalledTimes(2)
  expect(tasks.publishFailure.mock.calls[0][1].id).toBe(tasks.publishFailure.mock.calls[1][1].id)
})
it('preserves retry attempts across connector replacement and fences retries after cancellation', async () => {
  await tasks.accept(event('one')); const ctx = context()
  await tasks.deliver(ctx, { type: 'message', retryable: true, text: 'Container failed' })
  await tasks.disconnect()
  tasks = new FakeTasks(integration); bindHost(tasks); tasks.onEvent(event => { events.push(event) }); await tasks.connect()
  await tasks.recover()
  expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(30000); await tasks.recover()
  expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ dispatchAttempts: 2, status: 'running' })
  await tasks.stop('issue')
  await tasks.deliver(ctx, { type: 'message', retryable: true, text: 'Late failure' })
  expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'cancelled' })
  expect(tasks.publishFailure).not.toHaveBeenCalled()
})
it('uses the failing input ID instead of a previous turn reply target', async () => {
  await tasks.accept(event('one')); const old = context()
  await tasks.deliver(old, { type: 'turn-started' }); await tasks.deliver(old, { type: 'turn-completed', event: {} })
  await tasks.accept(event('two')); const next = context(1)
  await tasks.deliver(old, { type: 'message', inputId: next.replyTarget!.eventId, text: 'Could not create a session. Please try again.' })
  expect(await getTaskEvent(old.replyTarget!.eventId)).toMatchObject({ status: 'complete' })
  expect(await getTaskEvent(next.replyTarget!.eventId)).toMatchObject({ status: 'failed' })
  expect(tasks.publishFailure).toHaveBeenCalledOnce()
})

it('fences an event stopped after discovery but before durable acceptance', async () => {
  const late = event('late')
  expect(await wasStopped(integration.id, late)).toBe(false)
  await tasks.stop('issue')
  expect(await enqueueTaskEvent(integration.id, late)).toBe(false)
  expect(await pendingTaskEvents(integration.id)).toEqual([])
})

it('caps failure notices across restarts and releases the issue for later requests', async () => {
  vi.mocked(captureException).mockClear()
  const publish = vi.fn(async () => { throw new Error('Parent comment deleted') })
  tasks.publishFailure = publish
  await tasks.accept(event('one')); const ctx = context()
  await tasks.deliver(ctx, { type: 'message', text: 'Unable to start' })
  await tasks.accept(event('two'))
  await tasks.recover()
  expect(publish).toHaveBeenCalledTimes(1)
  expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  for (let attempt = 2; attempt <= 3; attempt++) {
    await tasks.disconnect()
    tasks = new FakeTasks(integration); bindHost(tasks); tasks.publishFailure = publish
    tasks.onEvent(event => { events.push(event) }); await tasks.connect()
    await vi.advanceTimersByTimeAsync(30000)
    await tasks.recover()
    expect(publish).toHaveBeenCalledTimes(attempt)
  }
  expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'failed', publicationJson: null })
  expect(events.filter(event => event.type === 'input')).toHaveLength(2)
  expect(captureException).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(30000); await tasks.recover()
  expect(publish).toHaveBeenCalledTimes(3)
  expect(captureException).toHaveBeenCalledOnce()
})
it('does not publish concurrent failure notices while recovery overlaps delivery', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const publishing = new Promise<void>(resolve => { started = resolve })
  tasks.publishFailure.mockImplementation(async () => { started(); await gate })
  await tasks.accept(event('one')); const ctx = context()
  const delivering = tasks.deliver(ctx, { type: 'message', text: 'Unable to start' })
  await publishing
  try {
    await vi.advanceTimersByTimeAsync(30000)
    await tasks.recover()
    expect(tasks.publishFailure).toHaveBeenCalledOnce()
  } finally { release(); await delivering }
  expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'failed' })
})
it('retires the failure notice after a crash on its last attempt without publishing again', async () => {
  await tasks.accept(event('one')); const ctx = context()
  await updateTaskEvent(ctx.replyTarget!.eventId, { status: 'responding', publicationJson: JSON.stringify(taskFailureNoticeSchema.parse({
    kind: 'failure_notice', id: ctx.replyTarget!.eventId, body: 'Unable to start', attempts: 3,
  })) })
  await tasks.accept(event('two'))
  await tasks.recover()
  expect(tasks.publishFailure).not.toHaveBeenCalled()
  expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'failed' })
  expect(events.filter(event => event.type === 'input')).toHaveLength(2)
})
it('atomically claims a legacy failure notice and fences competing recovery and cancellation', async () => {
  await tasks.accept(event('one')); const ctx = context()
  // Notices persisted before retry accounting default to zero attempts.
  await updateTaskEvent(ctx.replyTarget!.eventId, { status: 'responding', publicationJson: JSON.stringify({
    kind: 'failure_notice', id: ctx.replyTarget!.eventId, body: 'Unable to start',
  }) })
  const row = (await getTaskEvent(ctx.replyTarget!.eventId))!
  const claims = await Promise.all([claimTaskFailureNotice(row), claimTaskFailureNotice(row)])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(JSON.parse(claims.find(Boolean)!.publicationJson!)).toMatchObject({ attempts: 1 })
  const claimed = (await getTaskEvent(row.id))!
  await tasks.stop('issue')
  await vi.advanceTimersByTimeAsync(30000)
  expect(await claimTaskFailureNotice(claimed)).toBeUndefined()
})

it('schedules bounded retries for a failed accepted request without an external polling loop', async () => {
  expect(vi.getTimerCount()).toBe(0)
  await tasks.accept(event('one')); const ctx = context()
  await tasks.deliver(ctx, { type: 'message', retryable: true, text: 'Startup failed' })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(30000)
  await vi.waitFor(async () => expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ dispatchAttempts: 2, status: 'running' }))
  expect(vi.getTimerCount()).toBe(0)
  tasks.publishFailure.mockRejectedValue(new Error('Cannot publish'))
  await tasks.deliver(ctx, { type: 'message', text: 'Failed permanently' })
  for (let attempt = 2; attempt <= 3; attempt++) {
    await vi.advanceTimersByTimeAsync(30000)
    await vi.waitFor(() => expect(tasks.publishFailure).toHaveBeenCalledTimes(attempt))
  }
  await vi.waitFor(async () => expect(await getTaskEvent(ctx.replyTarget!.eventId)).toMatchObject({ status: 'failed' }))
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels retries for accepted work when the connector is paused', async () => {
  await tasks.accept(event('one')); const ctx = context()
  await tasks.deliver(ctx, { type: 'message', retryable: true, text: 'Startup failed' })
  await tasks.disconnect()
  await vi.advanceTimersByTimeAsync(300000)
  expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})


it('holds accepted work while the manager reports recovery as unknown, then resumes when idle', async () => {
  tasks.bindHost({ session: async externalId => ({ integration, externalId, sessionId: 'restoring', activity: 'unknown' }) })
  await tasks.accept(event('one'))
  await vi.advanceTimersByTimeAsync(600000)
  expect((await pendingTaskEvents(integration.id))[0].status).toBe('queued')
  expect(events.filter(event => event.type === 'input')).toHaveLength(0)
  tasks.bindHost({ session: async externalId => ({ integration, externalId, sessionId: 'restoring', activity: 'idle' }) })
  await tasks.recover()
  expect(events.filter(event => event.type === 'input')).toHaveLength(1)
})
it('settles a recovered waiting turn when the manager confirms there are no remaining requests', async () => {
  await tasks.accept(event('one')); const ctx = context()
  await tasks.deliver(ctx, { type: 'turn-started' })
  const request = pendingUserInputRequestSchema.parse({ id: 'question', kind: 'question', scope: { agentSlug: 'agent', sessionId: ctx.sessionId }, blocking: true, payload: {} })
  await tasks.deliver(ctx, { type: 'request-opened', request })
  await tasks.accept(event('two'))
  await tasks.deliver({ ...ctx, pendingRequests: [request] }, { type: 'turn-completed', event: {} })
  expect((await getTaskEvent(ctx.replyTarget!.eventId))?.status).toBe('awaiting_input')
  await tasks.deliver({ ...ctx, pendingRequests: [] }, { type: 'turn-completed', event: {} })
  expect((await getTaskEvent(ctx.replyTarget!.eventId))?.status).toBe('complete')
  expect(events.filter(event => event.type === 'input')).toHaveLength(2)
})
it('declares unfinished sessions for recovery and excludes completed issue history', async () => {
  await tasks.accept(event('one')); const first = context()
  await tasks.deliver(first, { type: 'turn-started' }); await tasks.deliver(first, { type: 'turn-completed', event: {} })
  await tasks.accept(event('two', 'another')); const second = context(1)
  await tasks.deliver(second, { type: 'turn-started' })
  expect(await tasks.sessionsToRecover()).toEqual([{ externalId: 'another', sessionId: second.sessionId }])
})
