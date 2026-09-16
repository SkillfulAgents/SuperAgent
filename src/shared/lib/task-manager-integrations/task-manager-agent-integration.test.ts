import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TaskAttachment } from './attachment-schema'
import { readTaskAttachment } from './attachments'
import { parseTaskJson, taskPublicationSchema } from './schemas'
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
const fileMocks = vi.hoisted(() => ({ files: new Map<string, string>(), beforeRead: undefined as (() => Promise<void>) | undefined }))
vi.mock('../agent-actor', () => ({ agentRegistry: { get: () => ({ sessions: { activity: () => 'idle' }, files: {
  resolve: async (p: string) => fileMocks.files.has(p) ? p : null,
  stat: async (p: string) => ({ kind: 'file', size: fileMocks.files.get(p)?.length ?? 0 }),
  read: async (p: string) => { await fileMocks.beforeRead?.(); return new Blob([fileMocks.files.get(p)!]).stream() },
} }) } }))
import { TaskManagerAgentIntegration } from './task-manager-agent-integration'
import { createChatIntegration, getChatIntegration } from '../services/chat-integration-service'
import { getTaskEvent, pendingTaskEvents } from './store'

const snapshot: TaskSnapshot = { id: 'issue', identifier: 'SUP-1', title: 'Work', description: 'Description', url: 'https://linear.app/issue', updatedAt: 'now', properties: {}, comments: [], attachments: [], truncated: false }
class FakeTasks extends TaskManagerAgentIntegration {
  readonly provider = 'fake'
  readonly definition = { provider: 'fake', name: 'Fake', family: 'task-manager', capabilities: [], settings: [], setup: { kind: 'test', credentialFields: [] } }
  published: Array<{ event: TaskEvent; publication: TaskPublication }> = []
  acknowledged: TaskEvent[] = []
  failAcknowledgement = false
  failPublication = false
  uploads: Array<{ attachment: TaskAttachment; bytes: string }> = []
  failUpload?: string
  beforeUpload?: () => Promise<void>
  protected async uploadTaskAttachment(attachment: TaskAttachment, bytes: Buffer, assertActive: () => void) {
    await this.beforeUpload?.()
    assertActive()
    this.uploads.push({ attachment: { ...attachment }, bytes: bytes.toString() })
    if (attachment.filename === this.failUpload) throw new Error('Storage failed')
    return `https://uploads.linear.app/${attachment.id}`
  }
  constructor(row: AgentIntegrationRecord) { super(row) }
  async connect() { this.connected = true }
  async disconnect() { this.connected = false }
  protected async acknowledgeTask(event: TaskEvent) {
    this.acknowledged.push(event)
    if (this.failAcknowledgement) throw new Error('Reaction failed')
  }
  protected async hydrateTask() { return snapshot }
  protected async publishTask(event: TaskEvent, publication: TaskPublication) {
    this.published.push({ event, publication })
    if (this.failPublication && publication.kind !== 'thought') throw new Error('Ambiguous network failure')
    return publication.id
  }
  protected taskTools(_taskId: string, assertActive: () => void) { return [{ name: 'edit', description: 'Edit', inputSchema: {}, execute: async () => { assertActive(); return true } }] }
  accept(event: TaskEvent) { return this.acceptTaskEvent(event) }
  stop(taskId: string, interactionId?: string, timestamp?: string) { return this.stopTask(taskId, interactionId, timestamp) }
  suspend(value: boolean) { this.dispatchSuspended = value }
  recover() { return this.recoverTasks() }
}
let dataDir: string
let integration: AgentIntegrationRecord
let tasks: FakeTasks
let events: IntegrationEvent[]
function event(id: string, taskId = 'issue'): TaskEvent { return { id, taskId, interactionId: id, kind: 'invocation', sourceCommentId: id, timestamp: new Date().toISOString(), text: 'Do work', replyTarget: { agentSessionId: id }, payload: {} } }
function context(index = 0): IntegrationSessionContext {
  const input = events.filter(event => event.type === 'input')[index]
  if (input.type !== 'input') throw new Error('Missing input')
  return { integration, ...tasks.resolveRoute(input), sessionId: `sdk-${input.externalId}` }
}
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-attachments-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  fileMocks.files.clear(); fileMocks.beforeRead = undefined
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite, { schema })
  migrate(testDb, { migrationsFolder: 'src/shared/lib/db/migrations' })
  const id = createChatIntegration({ agentSlug: 'agent', provider: 'telegram', config: { botToken: 'test' } })
  integration = getChatIntegration(id)!
  tasks = new FakeTasks(integration); events = []
  tasks.onEvent(event => { events.push(event) })
  await tasks.connect()
})
afterEach(async () => { sqlite.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(dataDir, { recursive: true, force: true }) })
describe('TaskManagerAgentIntegration', () => {
  it('acknowledges each durably accepted request once, including queued work, but not context', async () => {
    await tasks.accept(event('one')); await tasks.accept(event('two')); await tasks.accept(event('one'))
    await tasks.accept({ ...event('context'), kind: 'context' })
    expect(tasks.acknowledged.map(event => event.id)).toEqual(['one', 'two'])
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
    expect(tasks.published).toEqual([])
  })
  it('continues working when the native acknowledgement fails', async () => {
    tasks.failAcknowledgement = true
    await tasks.accept(event('one'))
    expect(events.filter(event => event.type === 'input')).toHaveLength(1)
  })

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
  it('holds recovered work until all cancellation controls have been accepted', async () => {
    tasks.suspend(true)
    const timestamp = new Date(Date.now() - 1000).toISOString()
    await tasks.accept({ ...event('offline'), timestamp })
    expect(events.filter(event => event.type === 'input')).toHaveLength(0)
    await tasks.stop('issue', undefined, timestamp)
    tasks.suspend(false)
    await tasks.recover()
    expect(events.filter(event => event.type === 'input')).toHaveLength(0)
  })
  it('scopes stops by issue and does not cancel newer work when an old stop is replayed', async () => {
    const timestamp = new Date(Date.now() - 1000).toISOString()
    await tasks.stop('issue', undefined, timestamp)
    await tasks.stop('other', undefined, timestamp)
    await tasks.accept({ ...event('old-other', 'other'), timestamp })
    expect(events.filter(event => event.type === 'input')).toHaveLength(0)
    await tasks.accept(event('new'))
    const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.stop('issue', undefined, timestamp)
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('running')
    expect(events.filter(event => event.type === 'cancel')).toHaveLength(0)
  })

})

function publication(ctx: IntegrationSessionContext): TaskPublication {
  return parseTaskJson(taskPublicationSchema, getTaskEvent(ctx.replyTarget!.eventId)!.publicationJson!)
}
async function prepareFiles(names = ['chart.png', 'data.csv']) {
  await tasks.accept(event('files')); const ctx = context()
  await tasks.deliver(ctx, { type: 'turn-started' })
  for (const name of names) fileMocks.files.set(`/workspace/${name}`, `original ${name}`)
  const tool = tasks.getTools(ctx).find(tool => tool.name === 'prepare_task_reply')!
  await tool.execute({ body: 'Here are the results.', attachments: names.map(name => ({ path: `/workspace/${name}`, caption: `Caption for ${name}` })) })
  return { ctx, tool }
}
describe('task reply attachments', () => {
  it('snapshots workspace bytes at preparation and only uploads after a successful turn', async () => {
    const { ctx } = await prepareFiles()
    expect(tasks.uploads).toEqual([])
    const draft = publication(ctx)
    expect(draft.attachments).toHaveLength(2)
    fileMocks.files.clear()
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'This final text must not replace the prepared reply or its attachments.' } })
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(tasks.uploads.map(upload => upload.bytes)).toEqual(['original chart.png', 'original data.csv'])
    expect(tasks.published.at(-1)?.publication).toMatchObject({ body: 'Here are the results.', attachments: [
      { filename: 'chart.png', contentType: 'image/png', assetUrl: expect.stringContaining('https://uploads.linear.app/') },
      { filename: 'data.csv', contentType: 'text/csv', assetUrl: expect.any(String) },
    ] })
    await expect(readTaskAttachment(integration.id, draft.id, draft.attachments![0])).rejects.toThrow()
  })
  it('checkpoints a partial upload and resumes after restart without rereading workspace files', async () => {
    const { ctx } = await prepareFiles()
    tasks.failUpload = 'data.csv'
    await expect(tasks.deliver(ctx, { type: 'turn-completed', event: {} })).rejects.toThrow('Storage failed')
    expect(tasks.published).toEqual([])
    const draft = publication(ctx)
    expect(draft.attachments![0].assetUrl).toBeTruthy()
    expect(draft.attachments![1].assetUrl).toBeUndefined()
    fileMocks.files.clear()
    await tasks.disconnect()
    tasks = new FakeTasks(integration); await tasks.connect()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000)
    await tasks.recover()
    expect(tasks.uploads.map(upload => upload.attachment.filename)).toEqual(['data.csv'])
    expect(tasks.published[0].publication.id).toBe(draft.id)
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('complete')
  })
  it('reuses every uploaded asset when comment delivery fails', async () => {
    const { ctx } = await prepareFiles(['chart.png'])
    tasks.failPublication = true
    await expect(tasks.deliver(ctx, { type: 'turn-completed', event: {} })).rejects.toThrow('network')
    const saved = publication(ctx)
    tasks.failPublication = false
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000)
    await tasks.recover()
    expect(tasks.uploads).toHaveLength(1)
    expect(tasks.published.map(item => item.publication)).toEqual([saved, saved])
  })
  it('discards files on a failed turn, and cleans superseded drafts', async () => {
    const { ctx, tool } = await prepareFiles(['chart.png'])
    const old = publication(ctx)
    await tool.execute({ body: 'Replacement', attachments: [{ path: '/workspace/chart.png' }] })
    const replacement = publication(ctx)
    await expect(readTaskAttachment(integration.id, old.id, old.attachments![0])).rejects.toThrow()
    await tasks.deliver(ctx, { type: 'turn-failed', event: {} })
    expect(tasks.uploads).toEqual([])
    expect(tasks.published.at(-1)?.publication).toMatchObject({ kind: 'error' })
    expect(tasks.published.at(-1)?.publication.attachments).toBeUndefined()
    await expect(readTaskAttachment(integration.id, replacement.id, replacement.attachments![0])).rejects.toThrow()
  })
  it('preserves the previous draft if a new attachment cannot be read', async () => {
    const { ctx, tool } = await prepareFiles(['chart.png'])
    const previous = publication(ctx)
    await expect(tool.execute({ body: 'Bad replacement', attachments: [{ path: '/workspace/chart.png' }, { path: '/workspace/missing.png' }] })).rejects.toThrow('existing workspace file')
    expect(publication(ctx)).toEqual(previous)
    expect(await fs.readdir(path.join(dataDir, 'integration-attachments', integration.id))).toEqual([previous.id])
  })
  it('cannot save a prepared reply after cancellation during file staging', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    fileMocks.files.set('/workspace/chart.png', 'image')
    fileMocks.beforeRead = () => tasks.stop('issue')
    await expect(tasks.getTools(ctx).find(tool => tool.name === 'prepare_task_reply')!.execute({ body: 'Late', attachments: [{ path: '/workspace/chart.png' }] })).rejects.toThrow('no longer active')
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.publicationJson).toBeNull()
    expect(tasks.uploads).toEqual([])
  })
  it('suppresses the final comment after cancellation during upload', async () => {
    const { ctx } = await prepareFiles(['chart.png'])
    tasks.beforeUpload = () => tasks.stop('issue')
    await expect(tasks.deliver(ctx, { type: 'turn-completed', event: {} })).rejects.toThrow('no longer active')
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('cancelled')
    expect(tasks.published.filter(item => item.publication.kind === 'response')).toEqual([])
  })
  it('does not start a second upload when recovery overlaps a slow upload', async () => {
    const { ctx } = await prepareFiles(['chart.png'])
    let started!: () => void; let release!: () => void
    const uploading = new Promise<void>(resolve => { started = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    tasks.beforeUpload = async () => { started(); await wait }
    const delivery = tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    await uploading
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000)
    const recovery = tasks.recover()
    release(); await Promise.all([delivery, recovery])
    expect(tasks.uploads).toHaveLength(1)
    expect(tasks.published.filter(item => item.publication.kind === 'response')).toHaveLength(1)
  })
  it('ignores reviews from other sessions and resumes only its matching review before publishing the saved draft', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    const request = { id: 'review', kind: 'proxy_review' as const, blocking: true, autoApproved: false,
      scope: { agentSlug: 'agent', sessionId: 'another-session' }, payload: {} }
    await tasks.deliver(ctx, { type: 'request', request })
    await tasks.deliver(ctx, { type: 'request', request: { ...request, scope: { agentSlug: 'agent' } } })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('running')
    expect(tasks.published).toEqual([])
    const draft = tasks.getTools(ctx).find(tool => tool.name === 'prepare_task_reply')!
    await draft.execute({ body: 'Saved answer' })
    await tasks.deliver(ctx, { type: 'request', request: { ...request, scope: { agentSlug: 'agent', sessionId: ctx.sessionId } } })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('awaiting_input')
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'user_request_resolved', requestId: 'other-review' } })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('awaiting_input')
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'user_request_resolved', requestId: 'review' } })
    expect(tasks.getTools(ctx).length).toBeGreaterThan(0)
    await tasks.deliver(ctx, { type: 'turn-completed', event: {} })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('complete')
    expect(tasks.published.at(-1)?.publication.body).toBe('Saved answer')
  })
  it('does not resurrect a failed run when a pending answer finishes late', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'request', request: { id: 'question', kind: 'question', blocking: true, autoApproved: false,
      scope: { agentSlug: 'agent', sessionId: ctx.sessionId }, payload: { questions: [{ question: 'Which branch?' }] } } })
    tasks.onEvent(async input => {
      if (input.type !== 'response') return
      await tasks.deliver(ctx, { type: 'turn-failed', event: {} })
      input.onAnswered?.()
    })
    await tasks.accept({ ...event('answer'), interactionId: 'one', text: 'main' })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.status).toBe('failed')
  })
  it('bounds streamed drafts and ignores late stream deltas from cancelled work', async () => {
    await tasks.accept(event('one')); const ctx = context()
    await tasks.deliver(ctx, { type: 'turn-started' })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'x'.repeat(48000) } })
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'end' } })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.responseText).toBe('x'.repeat(47997) + 'end')
    await tasks.stop('issue')
    await tasks.deliver(ctx, { type: 'runtime', event: { type: 'stream_delta', text: 'late' } })
    expect(getTaskEvent(ctx.replyTarget!.eventId)?.responseText?.endsWith('end')).toBe(true)
  })

})
