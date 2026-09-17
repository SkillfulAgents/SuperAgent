import { TaskManagerAgentIntegration } from '../task-manager-agent-integration'
import type { AgentIntegrationRecord, IntegrationSessionContext } from '../../agent-integrations/types'
import { getLinearConfig, updateLinearConfig } from './store'
import { LinearClient } from './client'
import { LinearTasks } from './tasks'
import { collectDirectActions } from './direct-sync'
import { LinearSubscriptions } from './subscriptions'
import type { DirectIssue } from './direct-schema'
import { checkpointIssue, dueIssues, getIssueTracking, hasDueIssues, initializeIssueSync, knownIssueIds, rememberIssue, wakeIssue } from './issue-sync-store'
import { findTaskEvent, pendingTaskEvents, wasStopped } from '../store'
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
  private hasBacklog = false
  private knownIssues = new Set<string>()
  private urgentIssues = new Set<string>()
  private readyIssues = new Set<string>()
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
    initializeIssueSync(this.installation.id, config.syncedThrough ?? new Date(config.authorizedAt ?? Date.now()).toISOString())
    this.knownIssues = knownIssueIds(this.installation.id)
    this.readyIssues.clear()
    this.urgentIssues = new Set(pendingTaskEvents(this.installation.id).map(row => row.taskId))
    this.subscriptions = new LinearSubscriptions({ client: this.client, appUserId: identity.appUserId,
      isTracked: id => this.knownIssues.has(id), onWake: id => {
        if (id) { this.urgentIssues.add(id); wakeIssue(this.installation.id, id) }
        this.schedule(250)
      }, onUnavailable: () => this.schedule(30000), onError: error => this.report(error, 'subscription') })
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
  protected canDispatchTask(taskId: string): boolean { return this.readyIssues.has(taskId) }
  protected async acceptTaskEvent(event: TaskEvent): Promise<void> {
    if (event.kind !== 'context' && !wasStopped(this.installation.id, event)) this.rememberTask(event)
    await super.acceptTaskEvent(event)
  }
  private rememberTask(event: TaskEvent): void {
    // Publish routing membership before any acknowledgement/network await.
    rememberIssue(this.installation.id, event.taskId, event.timestamp)
    this.knownIssues.add(event.taskId)
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
        if (!this.connected) return
        const normalDelay = this.urgentIssues.size || this.hasBacklog || !this.subscriptions?.isReady() ? 30000 : 300000
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
      const tracked = dueIssues(this.installation.id, this.urgentIssues)
      for (const id of tracked.keys()) this.urgentIssues.delete(id)
      const observed = new Map<string, DirectIssue | null>()
      const actions = await collectDirectActions({ client: this.client, appUserId: config.identity.appUserId,
        since, authorizedAt: new Date(config.authorizedAt ?? started).toISOString(), tracked, startedAt: started,
        onDiscover: event => { this.rememberTask(event); return getIssueTracking(this.installation.id, event.taskId) },
        onIssueRead: (id, issue) => observed.set(id, issue),
        shouldTrackEvent: event => !findTaskEvent(this.installation.id, event.id) && !wasStopped(this.installation.id, event), runOnStatusChange: config.runOnStatusChange, signal: this.abort.signal })
      if (!this.connected || getLinearConfig(this.installation.id).authorizationVersion !== config.authorizationVersion) return
      // Stops are applied before accepting backlog. Timestamp fencing allows new
      // mentions after a stop while suppressing withdrawn offline requests.
      for (const action of actions.filter(action => action.type === 'stop')) {
        if (!this.connected) return
        if (action.type === 'stop') await this.stopTask(action.taskId, undefined, action.timestamp)
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
      for (const [id, issue] of observed) {
        checkpointIssue(this.installation.id, id, issue, started)
        if (issue) this.readyIssues.add(id)
        else this.readyIssues.delete(id)
      }
      this.hasBacklog = hasDueIssues(this.installation.id)
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
