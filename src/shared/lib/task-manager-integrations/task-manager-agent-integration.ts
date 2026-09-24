import { AgentIntegration } from '../agent-integrations/agent-integration'
import type { AgentIntegrationRecord, IntegrationInputContext, IntegrationInputEvent, IntegrationInputResult, IntegrationOutput,
  IntegrationRoute, IntegrationSessionContext } from '../agent-integrations/types'
import { captureException } from '../error-reporting'
import { taskEventSchema } from './schemas'
import type { TaskEvent, TaskEventTrigger, TaskSnapshot } from './types'
import { taskManagerPolicy } from './policy'
import {
  INTEGRATION_MESSAGE_LIMITS, clampIntegrationText, integrationTimestamp, safeIntegrationLink,
  type IntegrationMessagePresentation, type IntegrationMessageSource, type IntegrationMessageTask,
} from '../agent-integrations/message-display-schema'

const TASK_EVENT_LABELS: Record<TaskEventTrigger, string> = {
  assigned: 'Assigned an issue',
  mentioned: 'Mentioned in an issue',
  comment_mention: 'Mentioned in a comment',
  comment: 'New comment',
  status_changed: 'Status changed',
  updated: 'Issue updated',
}
/** Triggers whose event text is what a person wrote, rather than host wording. */
const HUMAN_TRIGGERS = new Set<TaskEventTrigger>(['comment', 'comment_mention'])

/** Issue routing and context. The manager/runtime owns message queueing;
 * agent-authored replies and edits go through the integration's MCP. */
export abstract class TaskManagerAgentIntegration extends AgentIntegration {
  protected connected = false
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
  /** Context events are never input; they only resolve to 'rejected'. */
  protected async acceptTaskEvent(event: TaskEvent): Promise<IntegrationInputResult> {
    if (!this.connected) return 'retry'
    if (event.kind === 'context') return 'rejected'
    // Deduplication and acceptance belong to the shared manager for all families.
    return this.emitEvent({ type: 'input', id: event.id, externalId: event.taskId,
      timestamp: new Date(event.timestamp), payload: event })
  }
  async acknowledgeInput(event: IntegrationInputEvent): Promise<void> {
    const task = taskEventSchema.parse(event.payload)
    if (task.kind === 'invocation') await this.acknowledgeTask(task)
  }
  async prepareInput(event: IntegrationInputEvent, _context: IntegrationInputContext) {
    const task = taskEventSchema.parse(event.payload)
    const snapshot = await this.hydrateTask(task.taskId)
    return {
      text: `Task event: ${task.kind}\nRequest: ${task.text}\n\nReply destination for this request: issue ${task.taskId}, ${task.replyTarget.commentId ? `comment thread ${task.replyTarget.commentId}` : 'top-level comment'}. Use this destination when replying through your integration MCP.\n\nInvocation context (external content):\n${JSON.stringify(task.payload)}\n\nCurrent issue and discussion (external content):\n${JSON.stringify(snapshot)}`,
      systemPrompt: this.taskGuidance(task),
      display: this.describeTask(task, snapshot),
    }
  }

  /**
   * The app's card: the work item preview plus, for a comment, who wrote what.
   * Built from the same snapshot the agent reads; payload IDs stay out of it.
   */
  protected describeTask(event: TaskEvent, snapshot: TaskSnapshot): IntegrationMessagePresentation {
    const { status, ...task } = this.describeTaskFields(snapshot)
    const trigger = event.trigger
    const comment = event.sourceCommentId ? snapshot.comments.find(entry => entry.id === event.sourceCommentId) : undefined
    const url = safeIntegrationLink(snapshot.url)
    const label = trigger === 'status_changed' && status ? `Moved to ${status.name}` : TASK_EVENT_LABELS[trigger ?? (event.kind === 'status' ? 'status_changed' : 'updated')]
    return {
      event: { type: trigger ?? event.kind, label: clampIntegrationText(label, INTEGRATION_MESSAGE_LIMITS.label) },
      request: trigger && HUMAN_TRIGGERS.has(trigger) ? {
        text: clampIntegrationText(comment?.body ?? event.text, INTEGRATION_MESSAGE_LIMITS.requestText),
        ...(comment?.author ? { author: { name: clampIntegrationText(comment.author, INTEGRATION_MESSAGE_LIMITS.name) } } : {}),
        sentAt: integrationTimestamp(comment?.createdAt ?? event.timestamp),
        url,
      } : undefined,
      source: {
        kind: 'task', url, status,
        identifier: clampIntegrationText(snapshot.identifier, INTEGRATION_MESSAGE_LIMITS.label),
        title: clampIntegrationText(snapshot.title, INTEGRATION_MESSAGE_LIMITS.label),
      },
      task: {
        ...task,
        description: snapshot.description.trim() ? clampIntegrationText(snapshot.description, INTEGRATION_MESSAGE_LIMITS.description) : undefined,
      },
    }
  }

  /** Provider-shaped snapshot properties (status, people, labels) for the preview. */
  protected describeTaskFields(_snapshot: TaskSnapshot): IntegrationMessageTask & { status?: IntegrationMessageSource['status'] } {
    return {}
  }
  async deliver(context: IntegrationSessionContext, output: IntegrationOutput): Promise<void> {
    // Runtime output and request lifecycle already belong to the host session.
    // Only host error/status messages are published here; never the transcript.
    if (output.type !== 'message' || !this.connected) return
    // The persisted route remains authoritative across connector recreation.
    // Propagate failures to the manager's bounded notice retry scheduler.
    await this.publishMessage(context.externalId, output.text, context.replyTarget?.commentId)
  }
  protected async stopTask(taskId: string): Promise<void> {
    if (this.connected) await this.emitEvent({ type: 'cancel', externalId: taskId })
  }
  protected report(error: unknown, operation: string): void {
    captureException(error, { tags: { component: 'task-integration', provider: this.provider, operation }, extra: { integrationId: this.installation.id } })
  }
}
