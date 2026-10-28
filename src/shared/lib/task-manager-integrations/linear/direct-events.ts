import type { TaskEvent, TaskEventTrigger } from '../types'
import type { DirectComment, DirectHistory, DirectIssue, DirectNotification } from './direct-schema'

export interface TrackedLinearIssue { threads: Set<string> }
export type DirectAction = { type: 'event'; event: TaskEvent } | { type: 'stop'; taskId: string; timestamp: string }
function event(issue: DirectIssue, trigger: TaskEventTrigger, id: string, timestamp: string, text: string, payload: unknown, commentId?: string, sourceCommentId?: string): TaskEvent {
  return { id, taskId: issue.id, interactionId: issue.id, timestamp, text, payload, trigger,
    kind: 'invocation', sourceCommentId, title: `${issue.identifier}: ${issue.title}`, replyTarget: commentId ? { commentId } : {} }
}

export function notificationEvent(notification: DirectNotification, appUserId: string): TaskEvent | null {
  const issue = notification.issue
  if (!issue || notification.user.id !== appUserId || notification.actor?.app !== false || notification.actor.id === appUserId) return null
  if (notification.type === 'issueAssignedToYou') {
    // Ignore a notification whose delegation is already withdrawn.
    if (issue.delegate?.id !== appUserId || issue.archivedAt || issue.state.type === 'canceled') return null
    return event(issue, 'assigned', `assignment:${notification.id}`, notification.createdAt, 'This issue was delegated to you. Review it and carry out the requested work.', notification)
  }
  if (!['issueMention', 'issueCommentMention'].includes(notification.type)) return null
  const comment = notification.comment
  if (comment?.archivedAt) return null
  return event(issue, comment ? 'comment_mention' : 'mentioned', comment ? `comment:${comment.id}` : `mention:${notification.id}`, notification.createdAt,
    comment?.body ?? 'You were mentioned in this issue. Review the issue and respond to the request.', notification, comment ? comment.parent?.id ?? comment.id : undefined, comment?.id)
}

export function commentEvent(comment: DirectComment, appUserId: string, tracked: TrackedLinearIssue, created = true): TaskEvent | null {
  const issue = comment.issue
  if (!issue || comment.archivedAt || comment.user?.id === appUserId) return null
  const root = comment.parent?.id ?? comment.id
  // Other apps remain context, but cannot implicitly start or answer a turn.
  const invoke = created && comment.user?.app === false && (issue.delegate?.id === appUserId || tracked.threads.has(root))
  const result = event(issue, 'comment', invoke ? `comment:${comment.id}` : `comment-context:${comment.id}:${comment.updatedAt}`,
    invoke ? comment.createdAt : comment.updatedAt, comment.body, comment, root, comment.id)
  result.kind = invoke ? 'invocation' : 'context'
  return result
}

export function historyAction(history: DirectHistory, issue: DirectIssue, appUserId: string, runOnStatusChange: boolean): DirectAction {
  if (history.actor?.id !== appUserId && ((history.fromDelegate?.id === appUserId && history.toDelegate?.id !== appUserId) || history.archived || history.toState?.type === 'canceled')) {
    return { type: 'stop', taskId: issue.id, timestamp: history.updatedAt }
  }
  const status = !!history.fromState && !!history.toState && history.fromState.id !== history.toState.id
  const result = event(issue, status ? 'status_changed' : 'updated', `history:${history.id}:${history.updatedAt}`, history.updatedAt,
    status ? `Issue status changed to ${history.toState!.name}.` : 'Issue properties or linked context changed.', history)
  result.kind = status && runOnStatusChange && history.actor?.app === false && history.actor.id !== appUserId ? 'status' : 'context'
  return { type: 'event', event: result }
}
