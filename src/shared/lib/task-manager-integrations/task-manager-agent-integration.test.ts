import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentIntegrationRecord, IntegrationEvent, IntegrationInputContext, IntegrationInputEvent, IntegrationSessionContext } from '../agent-integrations/types'
import { captureException } from '../error-reporting'
import { pendingUserInputRequestSchema } from '../user-input/request-schema'
import type { TaskEvent, TaskSnapshot } from './types'
import { TaskManagerAgentIntegration } from './task-manager-agent-integration'
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
const snapshot: TaskSnapshot = { id: 'issue', identifier: 'SUP-1', title: 'Work', description: 'Description', url: 'https://linear.app/issue', updatedAt: 'now', properties: {}, comments: [], attachments: [], truncated: false }
class FakeTasks extends TaskManagerAgentIntegration {
  readonly provider = 'fake'
  readonly definition = { provider: 'fake', name: 'Fake', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  acknowledgeTask = vi.fn(async (_event: TaskEvent) => {})
  publishMessage = vi.fn(async (_taskId: string, _text: string, _parentId?: string) => {})
  hydrateTask = vi.fn(async (_taskId: string) => snapshot)
  constructor(row: AgentIntegrationRecord) { super(row) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  protected taskGuidance() { return 'Use your own MCP identity to reply. Follow the destination in each message.' }
  accept(event: TaskEvent) { return this.acceptTaskEvent(event) }
  stop(taskId: string) { return this.stopTask(taskId) }
}
const integration: AgentIntegrationRecord = { id: 'integration', agentSlug: 'agent', provider: 'fake', config: '{}', name: null, status: 'active', errorMessage: null,
  model: null, effort: null, speed: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }
let tasks: FakeTasks
let events: IntegrationEvent[]
function event(id: string, taskId = 'issue'): TaskEvent { return { id, taskId, interactionId: taskId, kind: 'invocation', sourceCommentId: id, timestamp: new Date().toISOString(), text: 'Do work', replyTarget: { commentId: 'root' }, payload: {} } }
function input(index = 0): IntegrationInputEvent { return events.filter((event): event is IntegrationInputEvent => event.type === 'input')[index] }
function context(index = 0): IntegrationSessionContext { return { integration, ...tasks.resolveRoute(input(index)), sessionId: 'session' } }
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks()
  tasks = new FakeTasks(integration); events = []
  tasks.onEvent(event => { events.push(event) })
  await tasks.connect()
})
afterEach(async () => { await tasks.disconnect(); vi.useRealTimers() })

describe('TaskManagerAgentIntegration live input', () => {
  it('hands every follow-up to the manager immediately without waiting for turn completion', async () => {
    const activityLookup = vi.fn(async () => ({ integration, externalId: 'issue', sessionId: 'session', activity: 'working' as const }))
    tasks.bindHost({ session: activityLookup })
    await tasks.accept(event('one'))
    await tasks.deliver(context(), { type: 'turn-started' })
    await tasks.accept(event('two'))
    expect(events.map(event => event.type)).toEqual(['input', 'input'])
    expect(tasks.resolveRoute(input(0)).externalId).toBe(tasks.resolveRoute(input(1)).externalId)
    expect(activityLookup).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('deduplicates concurrent live copies and acknowledges each comment once', async () => {
    await Promise.all([tasks.accept(event('one')), tasks.accept(event('one')), tasks.accept(event('two'))])
    expect(events).toHaveLength(2)
    expect(tasks.acknowledgeTask.mock.calls.map(([event]) => event.id)).toEqual(['one', 'two'])
  })
  it('bounds deduplication state and does not persist it across instances', async () => {
    for (let i = 0; i <= 1000; i++) await tasks.accept(event(String(i)))
    await tasks.accept(event('1000'))
    expect(events).toHaveLength(1001)
    await tasks.accept(event('0'))
    expect(events).toHaveLength(1002)
    await tasks.disconnect()
    tasks = new FakeTasks(integration); tasks.onEvent(event => { events.push(event) }); await tasks.connect()
    expect(await tasks.sessionsToRecover()).toEqual([])
    await tasks.accept(event('1000'))
    expect(events).toHaveLength(1003)
  })
  it('does not block input on an acknowledgement request', async () => {
    tasks.acknowledgeTask.mockImplementation(() => new Promise(() => {}))
    await tasks.accept(event('one')); await tasks.accept(event('two'))
    expect(events).toHaveLength(2)
  })
  it('reports acknowledgement failures without losing input', async () => {
    tasks.acknowledgeTask.mockRejectedValue(new Error('Reaction failed'))
    await tasks.accept(event('one')); await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(captureException).toHaveBeenCalled()
  })
  it('does not turn context changes into new work', async () => {
    await tasks.accept({ ...event('context'), kind: 'context' })
    expect(events).toEqual([])
    expect(tasks.acknowledgeTask).not.toHaveBeenCalled()
  })
  it('keeps each follow-up reply destination in its own model input', async () => {
    await tasks.accept(event('one'))
    await tasks.accept({ ...event('two'), replyTarget: { commentId: 'other-thread' } })
    const prepared = await tasks.prepareInput(input(1), context(1) as IntegrationInputContext)
    expect(prepared.text).toContain('comment thread other-thread')
    expect(prepared.text).toContain('SUP-1')
    expect(prepared.text).not.toContain('comment thread root')
    expect(tasks.hydrateTask).toHaveBeenCalledWith('issue')
  })
  it('treats an issue follow-up as input even while a Gamut question is open', async () => {
    await tasks.accept(event('one'))
    const request = pendingUserInputRequestSchema.parse({ id: 'question', kind: 'question', scope: { agentSlug: 'agent', sessionId: 'session' }, blocking: true, payload: {} })
    await tasks.deliver(context(), { type: 'request-opened', request })
    await tasks.accept(event('unrelated-follow-up'))
    expect(events).toHaveLength(2)
    expect(await tasks.consumeInput(input(1), context(1) as IntegrationInputContext, { text: 'Follow-up' })).toBe(false)
  })
  it('does not publish a transcript or an automatic completion reply', async () => {
    await tasks.accept(event('one'))
    await tasks.deliver(context(), { type: 'runtime', event: { type: 'text_delta', text: 'Private transcript' } })
    await tasks.deliver(context(), { type: 'turn-completed', event: {} })
    expect(tasks.publishMessage).not.toHaveBeenCalled()
  })
  it('publishes a dispatch failure once to its triggering thread, without a retry timer', async () => {
    await tasks.accept(event('one'))
    await tasks.accept({ ...event('two'), replyTarget: { commentId: 'other-thread' } })
    tasks.publishMessage.mockRejectedValueOnce(new Error('Offline'))
    await tasks.deliver(context(1), { type: 'message', inputId: 'one', text: 'Could not start. Please try again.', retryable: true })
    expect(tasks.publishMessage).toHaveBeenCalledExactlyOnceWith('issue', 'Could not start. Please try again.', 'root')
    await vi.advanceTimersByTimeAsync(3600000)
    expect(tasks.publishMessage).toHaveBeenCalledOnce()
    expect(events).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('hands cancellation to the manager without a task lock or persistent work row', async () => {
    await tasks.accept(event('one')); await tasks.accept(event('two'))
    await tasks.stop('issue')
    expect(events.at(-1)).toEqual({ type: 'cancel', externalId: 'issue' })
  })
  it('drops inputs and notices after disconnect', async () => {
    await tasks.accept(event('one')); await tasks.disconnect()
    await tasks.accept(event('two'))
    await tasks.deliver(context(), { type: 'message', text: 'Late notice' })
    expect(events).toHaveLength(1)
    expect(tasks.publishMessage).not.toHaveBeenCalled()
  })
})
