import { TaskManagerAgentIntegration } from '../task-manager-agent-integration'
import type { AgentIntegrationRecord, IntegrationSessionContext } from '../../agent-integrations/types'
import { getIntegrationSession, updateIntegrationStatus } from '../../agent-integrations/store'
import { acknowledgeEvents, pollAndClaimEvents } from '../../services/webhook-events-client'
import { getLinearConfig, updateLinearConfig } from './store'
import { LinearClient } from './client'
import { LinearTasks } from './tasks'
import { normalizeLinearWebhook, verifiedLinearWebhook } from './events'
import { findTaskEvent, pendingTaskEvents } from '../store'
import type { TaskEvent, TaskPublication } from '../types'

import { linearDefinition } from './definition'

export class LinearAgentIntegration extends TaskManagerAgentIntegration {
  readonly provider = 'linear'
  readonly definition = linearDefinition
  private readonly client: LinearClient
  private readonly tasks: LinearTasks
  private timer?: ReturnType<typeof setTimeout>
  private polling?: Promise<void>
  private failures = 0
  constructor(installation: AgentIntegrationRecord) {
    super(installation)
    this.client = new LinearClient(installation.id, undefined, () => { if (!this.connected) throw new Error('Linear integration is disconnected') })
    this.tasks = new LinearTasks(this.client)
  }
  async connect(): Promise<void> {
    const config = getLinearConfig(this.installation.id)
    if (config.authorizationPending || !config.tokens || !config.identity || !config.webhookSecret) throw new Error('Finish authorizing the Linear app')
    const identity = await new LinearClient(this.installation.id).identity()
    if (identity.appUserId !== config.identity.appUserId || identity.workspaceId !== config.identity.workspaceId) throw new Error('Linear app identity changed. Reconnect the integration.')
    this.connected = true
    this.schedule(0)
  }
  async disconnect(): Promise<void> {
    this.connected = false
    if (this.timer) clearTimeout(this.timer)
    // Any request already claimed is persisted before acknowledgement. No new
    // run or tool action is permitted after the connected flag is cleared.
    await this.polling
  }
  isAllowed(context: IntegrationSessionContext): boolean {
    if (!super.isAllowed(context)) return false
    const config = getLinearConfig(this.installation.id)
    return !config.authorizationPending && !!config.tokens && !!config.identity
  }
  protected hydrateTask(taskId: string) { return this.tasks.snapshot(taskId) }
  protected publishTask(event: TaskEvent, publication: TaskPublication) {
    return this.tasks.publish(event, publication, () => {
      const row = findTaskEvent(this.installation.id, event.id)
      const allowed = publication.kind === 'thought' ? ['queued', 'running'] : publication.kind === 'error' ? ['running', 'awaiting_input', 'responding', 'cancelled'] : ['running', 'awaiting_input', 'responding']
      if (!row || !allowed.includes(row.status)) throw new Error('Task reply is no longer active')
    })
  }
  protected taskTools(taskId: string, assertActive: () => void) { return this.tasks.tools(taskId, assertActive) }
  private schedule(delay: number): void {
    if (!this.connected) return
    this.timer = setTimeout(() => {
      this.polling = this.poll().catch(error => { this.failures++; this.report(error, 'poll') }).finally(() => {
        this.polling = undefined
        this.schedule(Math.min(30000, 2000 * 2 ** Math.min(this.failures, 4)))
      })
    }, delay)
    this.timer.unref()
  }
  private async poll(): Promise<void> {
    const config = getLinearConfig(this.installation.id)
    if (!config.webhookSecret || !config.tokens) { this.connected = false; return }
    const { events } = await pollAndClaimEvents(config.memberId, [config.endpointId])
    for (const event of events) {
      if (!this.connected) break
      if (event.composio_trigger_id !== config.endpointId) continue
      const payload = verifiedLinearWebhook(event.payload, config.webhookSecret)
      if (payload) {
        const action = normalizeLinearWebhook(payload, getLinearConfig(this.installation.id), id =>
          !!getIntegrationSession(this.installation.id, id) || pendingTaskEvents(this.installation.id).some(row => row.taskId === id))
        if (action?.type === 'event') await this.acceptTaskEvent(action.event)
        else if (action?.type === 'stop') await this.stopTask(action.taskId, action.interactionId, new Date(payload.webhookTimestamp).toISOString())
        else if (action?.type === 'revoke') {
          updateLinearConfig(this.installation.id, latest => ({ ...latest, tokens: undefined, oauth: undefined }))
          updateIntegrationStatus(this.installation.id, 'disconnected', 'Linear authorization was revoked. Reconnect the app.')
          for (const taskId of new Set(pendingTaskEvents(this.installation.id).map(row => row.taskId))) await this.stopTask(taskId)
          this.connected = false
        } else if (action?.type === 'permissions') {
          for (const taskId of new Set(pendingTaskEvents(this.installation.id).map(row => row.taskId))) {
            try { await this.tasks.issue(taskId) } catch { await this.stopTask(taskId) }
          }
        }
      }
      // Invalid signatures are discarded. Valid events were committed locally
      // before ACK; failure to ACK only causes a deduplicated redelivery.
      await acknowledgeEvents([event.id], config.memberId)
    }
    if (this.connected) await this.recoverTasks()
    this.failures = 0
  }
}
