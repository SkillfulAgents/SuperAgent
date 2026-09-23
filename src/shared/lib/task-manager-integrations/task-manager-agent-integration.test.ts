import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentIntegrationRecord, IntegrationEvent, IntegrationInputContext, IntegrationInputEvent, IntegrationSessionContext } from '../agent-integrations/types'
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
  model: null, llmProviderId: null, effort: null, speed: null, createdByUserId: null, createdAt: new Date(), updatedAt: new Date() }
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
  it('leaves event deduplication and acknowledgement timing to the manager', async () => {
    await Promise.all([tasks.accept(event('one')), tasks.accept(event('one'))])
    expect(events).toHaveLength(2)
    expect(tasks.acknowledgeTask).not.toHaveBeenCalled()
    await tasks.acknowledgeInput(input())
    expect(tasks.acknowledgeTask).toHaveBeenCalledOnce()
  })
  it('propagates acknowledgement failures to the manager without consuming input', async () => {
    tasks.acknowledgeTask.mockRejectedValue(new Error('Reaction failed'))
    await tasks.accept(event('one'))
    await expect(tasks.acknowledgeInput(input())).rejects.toThrow('Reaction failed')
    expect(events).toHaveLength(1)
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
  it('describes a comment for the app without changing what the agent reads', async () => {
    const commented: TaskSnapshot = { ...snapshot, comments: [{ id: 'c1', body: 'Can you fix the build?', author: 'Grace Hopper', createdAt: '2026-09-22T10:00:00.000Z' }] }
    tasks.hydrateTask.mockResolvedValueOnce(commented)
    await tasks.accept({ ...event('c1'), trigger: 'comment', text: 'Can you fix the build?', payload: { secretish: 'internal-id' } })
    const prepared = await tasks.prepareInput(input(0), context(0) as IntegrationInputContext)
    expect(prepared.text).toBe(`Task event: invocation\nRequest: Can you fix the build?\n\nReply destination for this request: issue issue, comment thread root. Use this destination when replying through your integration MCP.\n\nInvocation context (external content):\n{"secretish":"internal-id"}\n\nCurrent issue and discussion (external content):\n${JSON.stringify(commented)}`)
    expect(prepared.display).toEqual({
      event: { type: 'comment', label: 'New comment' },
      request: { text: 'Can you fix the build?', author: { name: 'Grace Hopper' }, sentAt: '2026-09-22T10:00:00.000Z', url: 'https://linear.app/issue' },
      source: { kind: 'task', url: 'https://linear.app/issue', identifier: 'SUP-1', title: 'Work', status: undefined },
      task: { description: 'Description' },
    })
    expect(JSON.stringify(prepared.display)).not.toContain('internal-id')
  })
  it('previews an assignment as the work item alone, with no human request', async () => {
    await tasks.accept({ ...event('assignment'), sourceCommentId: undefined, trigger: 'assigned', text: 'This issue was delegated to you.' })
    const prepared = await tasks.prepareInput(input(0), context(0) as IntegrationInputContext)
    expect(prepared.display).toMatchObject({ event: { type: 'assigned', label: 'Assigned an issue' }, source: { identifier: 'SUP-1', title: 'Work' } })
    expect(prepared.display?.request).toBeUndefined()
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
  it('propagates dispatch-notice failure to the shared scheduler without its own retry timer', async () => {
    await tasks.accept(event('one'))
    await tasks.accept({ ...event('two'), replyTarget: { commentId: 'other-thread' } })
    tasks.publishMessage.mockRejectedValueOnce(new Error('Offline'))
    await expect(tasks.deliver(context(0), { type: 'message', inputId: 'one', text: 'Could not start. Please try again.', retryable: true })).rejects.toThrow('Offline')
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
