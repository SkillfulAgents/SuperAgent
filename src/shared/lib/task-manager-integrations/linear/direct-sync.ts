import type { z } from 'zod'
import type { LinearClient } from './client'
import type { TaskEvent } from '../types'
import { directPageSchema, directNotificationsResponseSchema, directCommentsResponseSchema, directHistoryResponseSchema, directIssuesResponseSchema, type DirectIssue } from './direct-schema'
import { DIRECT_NOTIFICATIONS, DIRECT_COMMENTS, DIRECT_TRACKED_ISSUES, DIRECT_ISSUE_HISTORY } from './direct-queries'
import { commentEvent, historyAction, notificationEvent, type DirectAction, type TrackedLinearIssue } from './direct-events'

export interface DirectSyncOptions {
  client: LinearClient
  appUserId: string
  since: string
  authorizedAt: string
  runOnStatusChange: boolean
  tracked: Map<string, TrackedLinearIssue>
  signal: AbortSignal
  shouldTrackEvent?: (event: TaskEvent) => boolean
}
/** Read a complete recovery batch before dispatching any work: an offline
 * delegation and its later cancellation must be considered together. */
export async function collectDirectActions(options: DirectSyncOptions): Promise<DirectAction[]> {
  const { client, appUserId, since, signal } = options
  const tracked = new Map([...options.tracked].map(([id, item]) => [id, { ...item, threads: new Set(item.threads) }]))
  const actions: DirectAction[] = []
  const notifications = await pages(async after => {
    const result = await client.request(DIRECT_NOTIFICATIONS, { since, after }, directNotificationsResponseSchema, signal)
    return result.notifications
  })
  for (const notification of notifications) {
    const event = notificationEvent(notification, appUserId)
    if (!event || event.timestamp < options.authorizedAt || options.shouldTrackEvent?.(event) === false) continue
    actions.push({ type: 'event', event })
    const item = tracked.get(event.taskId) ?? { since: event.timestamp, threads: new Set<string>() }
    if (event.timestamp < item.since) item.since = event.timestamp
    if (event.replyTarget.commentId) item.threads.add(event.replyTarget.commentId)
    tracked.set(event.taskId, item)
  }
  // Filter on tracked IDs before fetching comment bodies; unrelated discussions
  // never enter local storage. Chunk IDs to bound GraphQL complexity.
  const ids = [...tracked.keys()]
  for (let offset = 0; offset < ids.length; offset += 50) {
    const comments = await pages(async after => {
      const result = await client.request(DIRECT_COMMENTS, { since, after, ids: ids.slice(offset, offset + 50) },
        directCommentsResponseSchema, signal)
      return result.comments
    })
    for (const comment of comments) {
      const item = comment.issue && tracked.get(comment.issue.id)
      if (!item) continue
      const event = commentEvent(comment, appUserId, item)
      if (event) actions.push({ type: 'event', event })
    }
  }
  // Reconcile existence/access in bulk. Read history only for issues changed
  // since the cursor; quiet issues must not each cost an HTTP request per poll.
  const currentIssues = new Map<string, DirectIssue>()
  for (let offset = 0; offset < ids.length; offset += 50) {
    const issues = await pages(async after => {
      const result = await client.request(DIRECT_TRACKED_ISSUES, { after, ids: ids.slice(offset, offset + 50) }, directIssuesResponseSchema, signal)
      return result.issues
    })
    for (const issue of issues) currentIssues.set(issue.id, issue)
  }
  for (const [id, item] of tracked) {
    const current = currentIssues.get(id)
    if (!current) {
      actions.push({ type: 'stop', taskId: id, timestamp: new Date().toISOString(), retire: true })
      continue
    }
    if (current.archivedAt || current.state.type === 'canceled') actions.push({ type: 'stop', taskId: id, timestamp: current.archivedAt ?? current.updatedAt })
    if (current.updatedAt < since) continue
    let after: string | null = null
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error('Linear history catch-up exceeded its page limit; checkpoint was not advanced')
      const result = await client.request(DIRECT_ISSUE_HISTORY, { id, after }, directHistoryResponseSchema, signal)
      const issue = result.issue
      for (const history of issue.history.nodes) {
        if (history.updatedAt >= since && history.updatedAt >= item.since) actions.push(historyAction(history, issue, appUserId, options.runOnStatusChange))
      }
      // Linear orders updatedAt descending. Stop once a complete page is older
      // than this checkpoint. Overlap is harmless because events have stable IDs.
      if (!issue.history.pageInfo.hasNextPage || (issue.history.nodes.length > 0 && issue.history.nodes.every(row => row.updatedAt < since))) break
      after = nextCursor(issue.history.pageInfo.endCursor, after)
    }
  }
  return actions.sort((a, b) => timestamp(a).localeCompare(timestamp(b)) || (a.type === 'stop' ? -1 : b.type === 'stop' ? 1 : 0))
}
function timestamp(action: DirectAction): string { return action.type === 'event' ? action.event.timestamp : action.timestamp }
function nextCursor(next: string | null, previous: string | null): string {
  if (!next || next === previous) throw new Error('Linear returned an invalid pagination cursor; checkpoint was not advanced')
  return next
}
async function pages<T>(fetchPage: (after: string | null) => Promise<{ nodes: T[]; pageInfo: z.infer<typeof directPageSchema> }>): Promise<T[]> {
  const result: T[] = []
  let after: string | null = null
  for (let page = 0; page < 100; page++) {
    const data = await fetchPage(after)
    result.push(...data.nodes)
    if (!data.pageInfo.hasNextPage) return result
    after = nextCursor(data.pageInfo.endCursor, after)
  }
  throw new Error('Linear catch-up exceeded its page limit; checkpoint was not advanced')
}
