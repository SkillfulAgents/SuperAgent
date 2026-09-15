import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'
import type { AgentIntegrationRecord, IntegrationEvent, IntegrationInputContext, IntegrationSessionContext } from '../agent-integrations/types'
import type { TaskEvent, TaskPublication, TaskSnapshot } from './types'
let sqlite: InstanceType<typeof Database>
let testDb: ReturnType<typeof drizzle>
vi.mock('../db', () => ({ get db() { return testDb } }))
vi.mock('../error-reporting', () => ({ captureException: vi.fn() }))
vi.mock('./summary', () => ({ summarizeTaskReply: async (text: string) => text }))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({ sessions: { activity: () => 'idle' } }) } }))
import { TaskManagerAgentIntegration } from './task-manager-agent-integration'
import { createChatIntegration, getChatIntegration } from '../services/chat-integration-service'
import { getTaskEvent, pendingTaskEvents } from './store'

const snapshot: TaskSnapshot = { id: 'issue', identifier: 'SUP-1', title: 'Work', description: 'Description', url: 'https://linear.app/issue', updatedAt: 'now', properties: {}, comments: [], attachments: [], truncated: false }
class FakeTasks extends TaskManagerAgentIntegration {
  readonly provider = 'fake'
  readonly definition = { provider: 'fake', name: 'Fake', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  published: Array<{ event: TaskEvent; publication: TaskPublication }> = []
  failPublication = false
  constructor(row: AgentIntegrationRecord) { super(row) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  protected async hydrateTask() { return snapshot }
  protected async publishTask(event: TaskEvent, publication: TaskPublication) {
    this.published.push({ event, publication })
    if (this.failPublication && publication.kind !== 'thought') throw new Error('Ambiguous network failure')
    return publication.id
  }
  protected taskTools(_taskId: string, assertActive: () => void) { return [{ name: 'edit', description: 'Edit', inputSchema: {}, execute: async () => { assertActive(); return true } }] }
  accept(event: TaskEvent) { return this.acceptTaskEvent(event) }
  stop(taskId: string, interactionId?: string) { return this.stopTask(taskId, interactionId) }
  recover() { return this.recoverTasks() }
}
let integration: AgentIntegrationRecord
let tasks: FakeTasks
let events: IntegrationEvent[]
function event(id: string, taskId = 'issue'): TaskEvent { return { id, taskId, interactionId: id, kind: 'invocation', acknowledge: true, timestamp: new Date().toISOString(), text: 'Do work', replyTarget: { agentSessionId: id }, payload: {} } }
function context(index = 0): IntegrationSessionContext {
  const input = events.filter(event => event.type === 'input')[index]
  if (input.type !== 'input') throw new Error('Missing input')
  return { integration, ...tasks.resolveRoute(input), sessionId: `sdk-${input.externalId}` }
}
beforeEach(async () => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  const id = createChatIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'test' } })
  integration = getChatIntegration(id)!
  tasks = new FakeTasks(integration); events = []
  tasks.onEvent(event => { events.push(event) })
  await tasks.connect()
})
afterEach(() => { sqlite.close(); vi.restoreAllMocks() })
describe('TaskManagerAgentIntegration', () => {
  it('serializes entire issue turns, allows other issues, and deduplicates deliveries', async () => {
    await tasks.accept(event('one')); await tasks.accept(event('two')); await tasks.accept(event('one')); await tasks.accept(event('three', 'other'))
    expect(events.filter(event => event.type === 'input')).toHaveLength(2)
    const first = context()
    await tasks.deliver(first, { type: 'turn-started' })
    await tasks.deliver(first, { type: 'runtime', event: { type: 'stream_delta', text: 'Done' } })
    await tasks.deliver(first, { type: 'turn-completed', event: {} })
    await tasks.recover()
    expect(events.filter(event => event.type === 'input')).toHaveLength(3)
    expect(tasks.published.find(item => item.publication.kind === 'response')).toMatchObject({ event: { replyTarget: { agentSessionId: 'one' } }, publication: { body: 'Done' } })
  })
  it('hydrates each invocation and preserves one stable issue session policy', async () => {
    await tasks.accept(event('one'))
    const input = events.find(event => event.type === 'input')!
    if (input.type !== 'input') throw new Error('Missing input')
    const prepared = await tasks.prepareInput(input, context() as IntegrationInputContext)
    expect(prepared.text).toContain('Description')
    expect(prepared.text).toContain('Do work')
    expect(tasks.sessionPolicy(integration, tasks.resolveRoute(input)).timeoutHours).toBeNull()
  })
  it('does not publish streaming progress or earlier commentary', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'I will investigate' } })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_start' } })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'The fix is ready.' } })
    expect(tasks.published.filter(item => item.publication.kind !== 'thought')).toHaveLength(0)
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(tasks.published.filter(item => item.publication.kind === 'response').map(item => item.publication.body)).toEqual(['The fix is ready.'])
  })
  it('persists a publication UUID before sending and retries without repeating the run', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'Done' } })
    tasks.failPublication = true
    await expect(tasks.deliver(ctx, { type: 'turn-completed', event: {} })).rejects.toThrow('network')
    expect(pendingTaskEvents(integration.id)[0].status).toBe('responding')
    tasks.failPublication = false
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000)
    await tasks.recover()
    const attempts = tasks.published.filter(item => item.publication.kind === 'response')
    expect(attempts).toHaveLength(2)
    expect(attempts[0].publication.id).toBe(attempts[1].publication.id)
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  })
  it('stages exact replies, publishes once, and suppresses a success draft after failure', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    expect(await tasks.getTools(ctx).find(tool => tool.name === 'prepare_task_reply')!.execute({ body: 'Exact reply' })).toEqual({ prepared: true, published: false })
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(tasks.published.at(-1)?.publication.body).toBe('Exact reply')
    await tasks.accept(event('two')); const second = context(1)
    await tasks.deliver(second, { type: 'turn-started' })
    await tasks.getTools(second).find(tool => tool.name === 'prepare_task_reply')!.execute({ body: 'Success' })
    await tasks.deliver(second, { type: 'turn-failed', event: {} })
    expect(tasks.published.at(-1)?.publication).toMatchObject({ kind: 'error' })
    expect(tasks.published.at(-1)?.publication.body).not.toBe('Success')
  })
  it('closes scoped tools before interrupting and rejects late pre-stop deliveries', async () => {
    const original = event('one'); original.timestamp = new Date(Date.now() - 1000).toISOString()
    await tasks.accept(original); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    const tool = tasks.getTools(ctx)[0]
    expect(tasks.getTools({ ...ctx, sessionId: 'other-session' })).toEqual([])
    await tasks.stop('issue', 'one')
    await expect(tool.execute({})).rejects.toThrow('no longer active')
    expect(events.at(-1)).toMatchObject({ type: 'cancel' })
    await tasks.accept({ ...original, id: 'late-delivery' })
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(tasks.published.filter(item => item.publication.kind === 'response')).toHaveLength(0)
  })
  it('answers single questions in their existing turn, with a valid activity UUID', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'request', request: { id: 'toolu_1', kind: 'question', blocking: true, autoApproved: false, scope: { agentSlug: 'agent', sessionId: ctx.sessionId }, payload: { questions: [{ question: 'Which branch?' }] } } })
    expect(tasks.published.at(-1)?.publication.id).toMatch(/^[\da-f-]{36}$/)
    tasks.onEvent(event => { if (event.type === 'response') event.onAnswered?.() })
    await tasks.accept({ ...event('answer'), interactionId: 'one', text: 'main' })
    expect(events.at(-1)).toMatchObject({ type: 'response', value: { 'Which branch?': 'main' } })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('running')
  })
})
