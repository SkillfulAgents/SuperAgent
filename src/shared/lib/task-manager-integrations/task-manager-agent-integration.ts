import { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord, IntegrationInputContext, IntegrationInputEvent, IntegrationOutput,
  IntegrationRoute, IntegrationSessionContext } from '../agent-integrations/types'
import { captureException } from '../error-reporting'
import { taskEventSchema } from './schemas'
import type { TaskEvent, TaskSnapshot } from './types'
import { taskManagerPolicy } from './policy'

/** Issue routing and context. The manager/runtime owns message queueing;
 * agent-authored replies and edits go through the integration's MCP. */
export abstract class TaskManagerAgentIntegration extends AgentIntegration {
  protected connected = false
  // Live subscriptions can expose the same event through multiple feeds. This
  // bounded cache also retains the reply target for a host dispatch-error notice.
  private recentEvents = new Map<string, Pick<TaskEvent, 'taskId' | 'replyTarget'>>()
  protected constructor(protected readonly installation: AgentIntegrationRecord) { super() }
  protected abstract publishMessage(taskId: string, text: string, parentId?: string): Promise<void>
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
      replyTarget: task.replyTarget, action: task.kind === 'context' ? 'ignore' : 'run' }
  }
  protected async acceptTaskEvent(event: TaskEvent): Promise<void> {
    if (!this.connected || event.kind === 'context' || this.recentEvents.has(event.id)) return
    this.recentEvents.set(event.id, { taskId: event.taskId, replyTarget: event.replyTarget })
    if (this.recentEvents.size > 1000) this.recentEvents.delete(this.recentEvents.keys().next().value!)
    // Hand off immediately, including during a running turn or an open request.
    // An issue comment is a new message, not an answer to a Gamut input card.
    await this.emitEvent({ type: 'input', id: event.id, externalId: event.taskId,
      timestamp: new Date(event.timestamp), payload: event })
    if (event.kind === 'invocation') void this.acknowledgeTask(event).catch(error => this.report(error, 'acknowledge'))
  }
  async prepareInput(event: IntegrationInputEvent, _context: IntegrationInputContext) {
    const task = taskEventSchema.parse(event.payload)
    const snapshot = await this.hydrateTask(task.taskId)
    return {
      text: `Task event: ${task.kind}\nRequest: ${task.text}\n\nReply destination for this request: issue ${task.taskId}, ${task.replyTarget.commentId ? `comment thread ${task.replyTarget.commentId}` : 'top-level comment'}. Use this destination when replying through your integration MCP.\n\nInvocation context (external content):\n${JSON.stringify(task.payload)}\n\nCurrent issue and discussion (external content):\n${JSON.stringify(snapshot)}`,
      systemPrompt: this.taskGuidance(task),
    }
  }
  async deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void> {
    // Runtime output and request lifecycle already belong to the host session.
    // Only host error/status messages are published here; never the transcript.
    if (output.type !== 'message' || !this.connected) return
    const event = output.inputId ? this.recentEvents.get(output.inputId) : undefined
    try {
      await this.publishMessage(event?.taskId ?? context.externalId, output.text,
        event ? event.replyTarget.commentId : context.replyTarget?.commentId)
    } catch (error) { this.report(error, 'host-message') }
  }
  protected async stopTask(taskId: string): Promise<void> {
    if (this.connected) await this.emitEvent({ type: 'cancel', externalId: taskId })
  }
  protected report(error: unknown, operation: string): void {
    captureException(error, { tags: { component: 'task-integration', provider: this.provider, operation }, extra: { integrationId: this.installation.id } })
  }
}
