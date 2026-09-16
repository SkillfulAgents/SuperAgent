import { TaskManagerAgentIntegration } from '../task-manager-agent-integration'
import type { AgentIntegrationRecord, IntegrationSessionContext } from '../../agent-integrations/types'
import { getLinearConfig, updateLinearConfig } from './store'
import { LinearClient } from './client'
import { LinearTasks } from './tasks'
import { collectDirectActions } from './direct-sync'
import { LinearSubscriptions } from './subscriptions'
import type { TrackedLinearIssue } from './direct-events'
import { enqueueTaskEvent, findTaskEvent, readTaskEvent, taskTrackingHistory, wasStopped } from '../store'
import type { TaskEvent, TaskPublication } from '../types'

import type { TaskAttachment } from '../attachment-schema'
import { uploadLinearAttachment } from './attachments'
import { linearDefinition } from './definition'

export class LinearAgentIntegration extends TaskManagerAgentIntegration {
  readonly provider = 'linear'
  readonly definition = linearDefinition
  private readonly client: LinearClient
  private readonly tasks: LinearTasks
  private timer?: ReturnType<typeof setTimeout>
  private scheduledAt = Infinity
  private polling?: Promise<void>
  private failures = 0
  private synced = false
  private dirty = false
  private tracked = new Map<string, TrackedLinearIssue>()
  private subscriptions?: LinearSubscriptions
  private abort = new AbortController()
  private recoveryTimer?: ReturnType<typeof setInterval>
  constructor(installation: AgentIntegrationRecord) {
    super(installation)
    this.client = new LinearClient(installation.id, undefined, () => { if (!this.connected) throw new Error('Linear integration is disconnected') })
    this.tasks = new LinearTasks(this.client)
  }
  isConnected(): boolean { return this.connected && this.synced && this.failures < 3 }
  async connect(): Promise<void> {
    const config = getLinearConfig(this.installation.id)
    if (config.authorizationPending || config.authorizationError || !config.tokens || !config.identity) throw new Error('Finish authorizing the Linear app')
    const identity = await new LinearClient(this.installation.id).identity()
    if (identity.appUserId !== config.identity.appUserId || identity.workspaceId !== config.identity.workspaceId) throw new Error('Linear app identity changed. Reconnect the integration.')
    this.connected = true
    this.synced = false
    this.failures = 0
    this.abort = new AbortController()
    this.dispatchSuspended = true
    this.subscriptions = new LinearSubscriptions({ client: this.client, appUserId: identity.appUserId,
      isTracked: id => this.tracked.has(id), onWake: () => this.schedule(250), onUnavailable: () => this.schedule(30000), onError: error => this.report(error, 'subscription') })
    // First catch up, then subscribe. A failed initial sync fails connection
    // setup so the manager can retry without advertising a healthy installation.
    this.polling = this.poll()
    try { await this.polling } catch (error) {
      this.stopDelivery()
      throw error
    } finally { this.polling = undefined }
    if (this.connected) {
      this.subscriptions.start()
      this.schedule(30000)
      this.recoveryTimer = setInterval(() => { if (this.isConnected() && !this.dispatchSuspended) void this.recoverTasks().catch(error => this.report(error, 'recover')) }, 30000)
      this.recoveryTimer.unref()
    }
  }
  async disconnect(): Promise<void> {
    this.connected = false
    clearTimeout(this.timer); this.timer = undefined; this.scheduledAt = Infinity
    clearInterval(this.recoveryTimer)
    this.subscriptions?.stop()
    this.abort.abort()
    await this.polling
  }

  isAllowed(context: IntegrationSessionContext): boolean {
    if (!super.isAllowed(context)) return false
    try {
      const config = getLinearConfig(this.installation.id)
      return !config.authorizationPending && !config.authorizationError && !!config.tokens && !!config.identity
    } catch { return false }
  }
  protected async acknowledgeTask(event: TaskEvent): Promise<void> {
    if (event.sourceCommentId) await this.tasks.acknowledge(event.sourceCommentId)
  }
  protected hydrateTask(taskId: string) { return this.tasks.snapshot(taskId) }
  protected publishTask(event: TaskEvent, publication: TaskPublication) {
    return this.tasks.publish(event, publication, () => {
      const row = findTaskEvent(this.installation.id, event.id)
      const allowed = publication.kind === 'thought' ? ['queued', 'running'] : publication.kind === 'error' ? ['running', 'awaiting_input', 'responding', 'cancelled'] : ['running', 'awaiting_input', 'responding']
      if (!row || !allowed.includes(row.status)) throw new Error('Task reply is no longer active')
    })
  }
  protected uploadTaskAttachment(attachment: TaskAttachment, bytes: Buffer, assertActive: () => void) {
    return uploadLinearAttachment(this.client, attachment, bytes, assertActive)
  }
  protected taskTools(taskId: string, assertActive: () => void) { return this.tasks.tools(taskId, assertActive) }
  private trackedIssues(): Map<string, TrackedLinearIssue> {
    const tracked = new Map<string, TrackedLinearIssue>()
    const history = taskTrackingHistory(this.installation.id).map(row => ({ ...row, event: readTaskEvent(row) }))
    const retired = new Map<string, string>()
    for (const { event } of history) {
      if (event.id.startsWith('retire:') && event.timestamp > (retired.get(event.taskId) ?? '')) retired.set(event.taskId, event.timestamp)
    }
    for (const { event, ...row } of history) {
      if (event.timestamp <= (retired.get(row.taskId) ?? '')) continue
      if (event.kind !== 'invocation' && event.kind !== 'status') continue
      const item = tracked.get(row.taskId) ?? { since: event.timestamp, threads: new Set<string>() }
      if (event.timestamp < item.since) item.since = event.timestamp
      if (event.replyTarget.commentId) item.threads.add(event.replyTarget.commentId)
      else if (row.publishedId) item.threads.add(row.publishedId)
      tracked.set(row.taskId, item)
    }
    return tracked
  }
  private schedule(delay: number): void {
    if (!this.connected) return
    if (this.polling) { this.dirty = true; return }
    const scheduledAt = Date.now() + delay
    if (this.timer && this.scheduledAt <= scheduledAt) return
    clearTimeout(this.timer)
    this.scheduledAt = scheduledAt
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.scheduledAt = Infinity
      this.dirty = false
      this.polling = this.poll().catch(error => {
        // Timer work must never leak a rejection, even after its DB row is gone.
        try { this.syncFailed(error) } catch { this.stopDelivery() }
      }).finally(() => {
        this.polling = undefined
        const normalDelay = this.subscriptions?.isReady() ? 300000 : 30000
        this.schedule(this.failures ? Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5)) : this.dirty ? 250 : normalDelay)
      })
    }, delay)
    this.timer.unref()
  }
  private async poll(): Promise<void> {
    const config = getLinearConfig(this.installation.id)
    if (!config.tokens || !config.identity || config.authorizationPending || config.authorizationError) { this.stopDelivery(); return }
    const started = Date.now()
    const since = config.syncedThrough ?? new Date(config.authorizedAt ?? started).toISOString()
    this.dispatchSuspended = true
    try {
      this.tracked = this.trackedIssues()
      const actions = await collectDirectActions({ client: this.client, appUserId: config.identity.appUserId,
        since, authorizedAt: new Date(config.authorizedAt ?? started).toISOString(), tracked: this.tracked, shouldTrackEvent: event => !findTaskEvent(this.installation.id, event.id) && !wasStopped(this.installation.id, event), runOnStatusChange: config.runOnStatusChange, signal: this.abort.signal })
      if (!this.connected || getLinearConfig(this.installation.id).authorizationVersion !== config.authorizationVersion) return
      // Stops are applied before accepting backlog. Timestamp fencing allows new
      // mentions after a stop while suppressing withdrawn offline requests.
      for (const action of actions.filter(action => action.type === 'stop')) {
        if (!this.connected) return
        if (action.type === 'stop') {
          await this.stopTask(action.taskId, undefined, action.timestamp)
          if (action.retire) {
            enqueueTaskEvent(this.installation.id, { id: `retire:${action.taskId}:${action.timestamp}`, taskId: action.taskId,
              interactionId: '', kind: 'context', timestamp: action.timestamp, text: 'Issue is no longer accessible', replyTarget: {}, payload: {} })
            this.tracked.delete(action.taskId)
          }
        }
      }
      for (const action of actions) {
        if (!this.connected) return
        if (action.type === 'event') await this.acceptTaskEvent(action.event)
      }
      if (!this.connected) return
      // Advance only after the entire paginated batch is durably accepted. Keep a
      // one-minute overlap for concurrent writes and clock/replication differences.
      updateLinearConfig(this.installation.id, latest => ({ ...latest,
        syncedThrough: new Date(Math.max(Date.parse(since), started - 60000)).toISOString() }))
      this.tracked = this.trackedIssues()
      this.failures = 0
      this.synced = true
    } finally { this.dispatchSuspended = false }
    await this.recoverTasks().catch(error => this.report(error, 'recover'))
  }
  private syncFailed(error: unknown): void {
    if (!this.connected || this.abort.signal.aborted) return
    let config: ReturnType<typeof getLinearConfig>
    try { config = getLinearConfig(this.installation.id) } catch { this.stopDelivery(); return }
    if (!config.tokens || config.authorizationPending || config.authorizationError) { this.stopDelivery(); return }
    this.failures++
    if (this.failures === 1) this.report(error, 'sync')
    // One notification per outage; normal socket outages still use healthy polling.
    if (this.failures === 3) this.emitError(new Error('Linear could not sync new events. Retrying automatically; check connectivity and app access if this continues.'))
  }
  private stopDelivery(): void {
    this.connected = false
    this.subscriptions?.stop()
    clearTimeout(this.timer); this.timer = undefined; this.scheduledAt = Infinity
    clearInterval(this.recoveryTimer)
    this.abort.abort()
  }
}
