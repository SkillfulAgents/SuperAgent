import { z } from 'zod'
import { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord, IntegrationInputContext, IntegrationInputEvent, IntegrationOutput,
  IntegrationRoute, IntegrationSessionContext } from '../agent-integrations/types'
import { agentRegistry } from '../agent-actor'
import { getIntegration, getIntegrationSession } from '../agent-integrations/store'
import { pendingUserInputRequestSchema } from '../user-input/request-schema'
import { captureException } from '../error-reporting'
import { activeTaskEvent, claimTaskEvent, enqueueTaskEvent, getTaskEvent, pendingTaskEvents,
  failTaskDispatch, finishTaskEvent, claimTaskFailureNotice, MAX_FAILURE_NOTICE_ATTEMPTS, resumeTaskInput, readTaskEvent, taskContextUpdates, updateTaskEvent, updateActiveTaskEvent, type StoredTaskEvent } from './store'
import { parseTaskJson, taskEventSchema, taskRuntimeEventSchema, taskFailureNoticeSchema } from './schemas'
import type { TaskEvent, TaskSnapshot } from './types'
import { taskManagerPolicy } from './policy'

/** Inbound identity, ordering, context and run lifecycle. Outbound work belongs
 * to the integration's MCP; completing a turn never publishes a second reply. */
export abstract class TaskManagerAgentIntegration extends AgentIntegration {
  protected connected = false
  protected dispatchSuspended = false
  private draining = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryAt = Infinity
  private deliveries = new Map<string, Promise<void>>()
  private publishingFailures = new Set<string>()
  private restoringSessions = new Set<string>()
  private deferredObservations = new Map<string, IntegrationSessionContext>()
  protected constructor(protected readonly installation: AgentIntegrationRecord) { super() }
  protected async readyToDispatch(): Promise<boolean> { return true }
  protected canDispatchTask(_taskId: string): boolean { return true }
  protected abstract publishFailure(event: TaskEvent, notice: z.infer<typeof taskFailureNoticeSchema>): Promise<void>
  protected abstract hydrateTask(taskId: string): Promise<TaskSnapshot>
  protected abstract taskGuidance(event: TaskEvent): string
  protected async acknowledgeTask(_event: TaskEvent): Promise<void> {}
  isConnected(): boolean { return this.connected }
  async isAllowed(context: IntegrationSessionContext): Promise<boolean> { return taskManagerPolicy.isAllowed(context) }
  sessionPolicy = taskManagerPolicy.sessionPolicy
  async authorize(context: IntegrationSessionContext): Promise<boolean> { return this.isAllowed(context) }

  resolveRoute(event: IntegrationInputEvent): IntegrationRoute {
    const task = taskEventSchema.parse(event.payload)
    return { externalId: task.taskId, interactionId: task.interactionId, displayName: task.title,
      replyTarget: { ...task.replyTarget, eventId: event.id }, action: 'run' }
  }
  protected async acceptTaskEvent(event: TaskEvent): Promise<void> {
    if (!this.connected) return
    // Plain issue comments are new work. Native blocking requests are answered
    // in Gamut; an issue ID is not proof that a comment answers that request.
    const inserted = await enqueueTaskEvent(this.installation.id, event)
    if (inserted && event.kind === 'invocation') await this.acknowledgeTask(event).catch(error => this.report(error, 'acknowledge'))
    await this.drainTasks()
  }
  protected async drainTasks(): Promise<void> {
    if (this.draining || !this.isConnected() || this.dispatchSuspended) return
    this.draining = true
    try {
      const pendingEvents = await pendingTaskEvents(this.installation.id)
      if (!pendingEvents.some(row => row.status === 'queued') || !await this.readyToDispatch()) return
      const integration = await getIntegration(this.installation.id)
      if (!integration || !await this.isAllowed({ integration, externalId: '' })) return
      const considered = new Set<string>()
      for (const pending of pendingEvents) {
        if (!this.connected || this.dispatchSuspended) return
        if (considered.has(pending.taskId)) continue
        considered.add(pending.taskId)
        if (pending.status !== 'queued' || !this.canDispatchTask(pending.taskId)) continue
        const cooldown = pending.updatedAt.getTime() + 30000 * pending.dispatchAttempts - Date.now()
        if (pending.dispatchAttempts > 0 && cooldown > 0) { this.requestTaskRetry(cooldown); continue }
        const session = await getIntegrationSession(this.installation.id, pending.taskId)
        if (session && agentRegistry.get(this.installation.agentSlug).sessions.activity(session.sessionId) !== 'idle') continue
        const row = await claimTaskEvent(pending.id)
        if (!row || !this.connected || (await getTaskEvent(row.id))?.status !== 'running') continue
        const task = readTaskEvent(row)
        await this.emitEvent({ type: 'input', id: row.id, externalId: task.taskId, timestamp: new Date(task.timestamp), payload: task })
      }
    } finally { this.draining = false }
  }
  async prepareInput(event: IntegrationInputEvent, _context: IntegrationInputContext) {
    const row = await getTaskEvent(event.id)
    if (!row || row.status !== 'running' || row.integrationId !== this.installation.id) return { text: '', skip: true }
    const task = readTaskEvent(row)
    const snapshot = await this.hydrateTask(task.taskId)
    if ((await getTaskEvent(row.id))?.status !== 'running') return { text: '', skip: true }
    return {
      text: `Task event: ${task.kind}\nRequest: ${task.text}\n\nInvocation context (external content):\n${JSON.stringify(task.payload)}\n\nCurrent issue and discussion (external content):\n${JSON.stringify(snapshot)}\n\nRecent issue events (external content):\n${JSON.stringify(await taskContextUpdates(this.installation.id, task.taskId))}`,
      systemPrompt: this.taskGuidance(task),
    }
  }
  async deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void> {
    const previous = this.deliveries.get(context.externalId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.deliverInOrder(context, output))
    this.deliveries.set(context.externalId, next)
    try { await next } finally { if (this.deliveries.get(context.externalId) === next) this.deliveries.delete(context.externalId) }
  }
  private async deliverInOrder(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void> {
    // Streaming text and tool traces already belong to the normal session log.
    if (output.type === 'runtime') {
      const event = taskRuntimeEventSchema.safeParse(output.event)
      if (!event.success || !['user_request_created', 'user_request_resolved'].includes(event.data.type)) return
    }
    const eventId = output.type === 'message' && output.inputId ? output.inputId : context.replyTarget?.eventId
    const row = eventId ? await getTaskEvent(eventId) : await activeTaskEvent(this.installation.id, context.externalId)
    if (!row || row.integrationId !== this.installation.id || row.taskId !== context.externalId || !['running', 'awaiting_input'].includes(row.status)) return
    if (output.type === 'turn-started') { await updateActiveTaskEvent(row.id, { sessionId: context.sessionId }); return }
    if (output.type === 'message') {
      const failed = await failTaskDispatch(row.id, output.text, output.retryable ?? false)
      if (failed?.status === 'responding') { await this.deliverFailure(failed); await this.drainTasks() }
      else if (failed?.status === 'queued') this.requestTaskRetry(30000 * failed.dispatchAttempts)
      return
    }
    if (!row.sessionId || row.sessionId !== context.sessionId) return
    if (output.type === 'runtime') {
      const event = taskRuntimeEventSchema.parse(output.event)
      if (event.type === 'user_request_created') {
        const data = z.object({ request: pendingUserInputRequestSchema }).safeParse(output.event)
        if (data.success) await this.requestInput(row, data.data.request)
      }
      if (event.type === 'user_request_resolved' && event.requestId) await resumeTaskInput(row.id, event.requestId)
    } else if (output.type === 'request') await this.requestInput(row, output.request)
    else if (output.type === 'turn-completed' || output.type === 'turn-failed') {
      if (output.type === 'turn-completed' && row.status === 'awaiting_input') return
      await finishTaskEvent(row.id, output.type === 'turn-completed' ? 'complete' : 'failed')
      await this.drainTasks()
    }
  }
  private async requestInput(row: StoredTaskEvent, request: z.infer<typeof pendingUserInputRequestSchema>): Promise<void> {
    if (request.scope.agentSlug !== this.installation.agentSlug || request.scope.sessionId !== row.sessionId) return
    if (row.inputRequestJson || request.autoApproved || !request.blocking) return
    await updateActiveTaskEvent(row.id, { status: 'awaiting_input', inputRequestJson: JSON.stringify(pendingUserInputRequestSchema.parse(request)) })
  }
  protected async stopTask(taskId: string, interactionId?: string, timestamp = new Date().toISOString()): Promise<void> {
    if (!await enqueueTaskEvent(this.installation.id, { id: `stop:${taskId}:${interactionId ?? '*'}:${timestamp}`, taskId,
      interactionId: interactionId ?? '', kind: 'context', timestamp, text: 'Stop requested', replyTarget: {}, payload: {} })) return
    const rows = (await pendingTaskEvents(this.installation.id)).filter(row => row.taskId === taskId && (!interactionId || row.interactionId === interactionId) && Date.parse(readTaskEvent(row).timestamp) <= Date.parse(timestamp))
    for (const row of rows) await updateTaskEvent(row.id, { status: 'cancelled', publicationJson: null })
    if (rows.some(row => row.sessionId)) await this.emitEvent({ type: 'cancel', externalId: taskId })
    await this.drainTasks()
  }
  protected async recoverTasks(): Promise<void> {
    if (!this.isConnected() || this.dispatchSuspended) return
    // Restore only locally accepted work; providers do not need to replay remote history.
    const observations = [...this.deferredObservations.values()]
    this.deferredObservations.clear()
    for (const context of observations) await this.restoreSession(context).catch(error => {
      this.deferredObservations.set(context.externalId, context)
      this.requestTaskRetry()
      this.report(error, 'restore-stream')
    })
    for (const row of await pendingTaskEvents(this.installation.id)) {
      if (row.status === 'queued') continue
      if (row.status === 'responding') { await this.deliverFailure(row); continue }
      const sessionId = row.sessionId ?? (await getIntegrationSession(this.installation.id, row.taskId))?.sessionId
      if (sessionId && agentRegistry.get(this.installation.agentSlug).sessions.activity(sessionId) !== 'idle') continue
      const remaining = (sessionId ? 120000 : 600000) - (Date.now() - row.updatedAt.getTime())
      if (remaining > 0) { this.requestTaskRetry(remaining); continue }
      await finishTaskEvent(row.id, 'failed')
    }
    await this.drainTasks()
  }
  private async deliverFailure(row: StoredTaskEvent): Promise<void> {
    // Legacy transcript drafts must never be posted alongside MCP output.
    let notice: z.infer<typeof taskFailureNoticeSchema>
    try { notice = parseTaskJson(taskFailureNoticeSchema, row.publicationJson ?? '') }
    catch { await finishTaskEvent(row.id, 'failed'); return }
    if (!this.connected || !await this.isAllowed({ integration: this.installation, externalId: row.taskId })) return
    if (this.publishingFailures.has(row.id)) return
    // A crash after the final claim must not restart the retry budget.
    if (notice.attempts >= MAX_FAILURE_NOTICE_ATTEMPTS) { await finishTaskEvent(row.id, 'failed'); return }
    this.publishingFailures.add(row.id)
    try {
      const claimed = await claimTaskFailureNotice(row)
      if (!claimed) return
      notice = parseTaskJson(taskFailureNoticeSchema, claimed.publicationJson!)
      try {
        await this.publishFailure(readTaskEvent(claimed), notice)
        await finishTaskEvent(row.id, 'failed')
      } catch (error) {
        if (notice.attempts >= MAX_FAILURE_NOTICE_ATTEMPTS) {
          await finishTaskEvent(row.id, 'failed')
          this.report(error, 'failure-notice')
        } else this.requestTaskRetry()
      }
    } finally { this.publishingFailures.delete(row.id) }
  }
  /** One-shot retries for accepted work. Idle integrations schedule no checks. */
  protected requestTaskRetry(delay = 30000): void {
    if (!this.connected) return
    const retryAt = Date.now() + delay
    if (this.retryTimer && this.retryAt <= retryAt) return
    clearTimeout(this.retryTimer)
    this.retryAt = retryAt
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.retryAt = Infinity
      if (this.connected) void this.recoverTasks().catch(error => this.report(error, 'retry'))
    }, delay)
    this.retryTimer.unref()
  }
  protected stopTaskRetries(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryAt = Infinity
  }
  releaseSession(context: IntegrationSessionContext): void {
    this.deferredObservations.delete(context.externalId)
  }
  observeSession(context: IntegrationSessionContext): void {
    if (!this.isConnected() || this.dispatchSuspended) {
      this.deferredObservations.set(context.externalId, context)
      return
    }
    void this.restoreSession(context).catch(error => this.report(error, 'restore-stream'))
  }
  private async restoreSession(context: IntegrationSessionContext): Promise<void> {
    const row = await activeTaskEvent(this.installation.id, context.externalId)
    const sessionId = context.sessionId
    if (!this.isConnected() || !row || !sessionId || row.sessionId !== sessionId || this.restoringSessions.has(sessionId)) return
    const actor = agentRegistry.get(this.installation.agentSlug)
    if (actor.sessions.isStreamSubscribed(sessionId)) return
    this.restoringSessions.add(sessionId)
    try { await actor.container.start(); if (this.connected) await actor.sessions.subscribeStream(sessionId, sessionId) }
    finally { this.restoringSessions.delete(sessionId) }
  }
  protected report(error: unknown, operation: string): void {
    captureException(error, { tags: { component: 'task-integration', provider: this.provider, operation }, extra: { integrationId: this.installation.id } })
  }
}
