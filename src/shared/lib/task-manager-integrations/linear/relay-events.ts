import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { webhookEnvelopeSchema } from '../../services/webhook-endpoint-schema'
import type { RelayEvent } from '../../webhook-relay'
import type { LinearClient } from './client'
import { COMMENT_FIELDS, HISTORY_FIELDS, ISSUE_FIELDS } from './direct-queries'
import {
  directCommentSchema,
  directHistorySchema,
  directIssueSchema,
  directNotificationSchema,
  type DirectHistory,
  type DirectSubscriptionEvent,
} from './direct-schema'

/**
 * Relay transport for Linear: the app's webhooks, received by the host's
 * webhook relay. A webhook is only a pointer. Each one is checked, then the
 * entity it names is read back through the same GraphQL fields the direct
 * subscriptions use, so both transports feed identical events (and event ids)
 * into one path.
 */

/** Linear signs `webhookTimestamp` and expects a delivery within a minute of it. */
const MAX_DELIVERY_DELAY_MS = 60_000
/** How far from a webhook's change time the issue history entry it reports may be. */
const HISTORY_MATCH_WINDOW_MS = 10_000

const webhookBodySchema = z.object({
  type: z.string(),
  action: z.string(),
  createdAt: z.string(),
  webhookTimestamp: z.number(),
}).loose()
const notificationWebhookSchema = webhookBodySchema.extend({
  type: z.literal('AppUserNotification'),
  appUserId: z.string(),
  notification: z.object({ id: z.string() }).loose(),
})
const commentWebhookSchema = webhookBodySchema.extend({
  type: z.literal('Comment'),
  data: z.object({ id: z.string(), issueId: z.string().nullish(), userId: z.string().nullish() }).loose(),
})
const issueWebhookSchema = webhookBodySchema.extend({
  type: z.literal('Issue'),
  data: z.object({ id: z.string(), delegateId: z.string().nullish(), stateId: z.string().nullish() }).loose(),
  updatedFrom: z.record(z.string(), z.unknown()).nullish(),
})
export type LinearWebhookBody = z.infer<typeof webhookBodySchema>

export type LinearWebhookCheck =
  | { ok: true; body: LinearWebhookBody }
  /** `signature` means the secret doesn't match; everything else is a delivery to drop. */
  | { ok: false; reason: 'not_linear' | 'handshake' | 'signature' | 'stale' }

/**
 * Verifies `Linear-Signature` (hex HMAC-SHA256 of the raw body) and that the
 * relay received the delivery within a minute of Linear signing it. The
 * receive time, not now, because relayed events may be claimed much later.
 */
export function checkLinearWebhook(event: RelayEvent, secret: string): LinearWebhookCheck {
  const envelope = webhookEnvelopeSchema.safeParse(event.payload)
  if (!envelope.success || envelope.data.body === undefined) return { ok: false, reason: 'not_linear' }
  if (envelope.data.kind === 'handshake') return { ok: false, reason: 'handshake' }
  const raw = Buffer.from(envelope.data.body, envelope.data.body_encoding === 'base64' ? 'base64' : 'utf8')
  const signature = envelope.data.headers?.['linear-signature']
  if (!signature) return { ok: false, reason: 'not_linear' }
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature' }

  let body: LinearWebhookBody
  try {
    body = webhookBodySchema.parse(JSON.parse(raw.toString('utf8')))
  } catch {
    return { ok: false, reason: 'not_linear' }
  }
  const receivedAt = Date.parse(envelope.data.received_at ?? event.createdAt)
  if (!Number.isFinite(receivedAt) || Math.abs(receivedAt - body.webhookTimestamp) > MAX_DELIVERY_DELAY_MS) return { ok: false, reason: 'stale' }
  return { ok: true, body }
}

const NOTIFICATION_QUERY = `query($id:String!){notification(id:$id){id type createdAt updatedAt user{id} actor{id app} ...on IssueNotification{issue{${ISSUE_FIELDS}} comment{${COMMENT_FIELDS}}}}}`
const COMMENT_QUERY = `query($id:String!){comment(id:$id){${COMMENT_FIELDS} issue{${ISSUE_FIELDS}}}}`
const HISTORY_PAGE = 50
/** Enough to reach a change from well before a long offline stretch on a busy issue. */
const MAX_HISTORY_PAGES = 10
const HISTORY_FORWARD_QUERY = `query($id:String!,$after:String){issue(id:$id){${ISSUE_FIELDS} history(first:${HISTORY_PAGE},after:$after){nodes{${HISTORY_FIELDS}} pageInfo{hasNextPage endCursor}}}}`
const HISTORY_BACKWARD_QUERY = `query($id:String!,$before:String){issue(id:$id){${ISSUE_FIELDS} history(last:${HISTORY_PAGE},before:$before){nodes{${HISTORY_FIELDS}} pageInfo{hasPreviousPage startCursor}}}}`

const forwardHistoryResult = z.object({ issue: directIssueSchema.extend({ history: z.object({
  nodes: z.array(directHistorySchema), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
}) }) })
const backwardHistoryResult = z.object({ issue: directIssueSchema.extend({ history: z.object({
  nodes: z.array(directHistorySchema), pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable() }),
}) }) })

/**
 * The issue as it is now, and its history back to just before `since`. Pages
 * from the newest end, whichever order the API lists history in, so a change
 * from before a long offline stretch is still found on a busy issue.
 */
async function issueHistorySince(client: LinearClient, issueId: string, since: number) {
  const reachedSince = (nodes: readonly DirectHistory[]) => nodes.some((entry) => Date.parse(entry.createdAt) < since)
  const first = await client.request(HISTORY_FORWARD_QUERY, { id: issueId }, forwardHistoryResult)
  const { history, ...current } = first.issue
  const entries = [...history.nodes]
  const newestFirst = history.nodes.length < 2 || Date.parse(history.nodes[0].createdAt) >= Date.parse(history.nodes.at(-1)!.createdAt)
  if (newestFirst) {
    let page = history
    for (let pages = 1; page.pageInfo.hasNextPage && !reachedSince(page.nodes) && pages < MAX_HISTORY_PAGES; pages++) {
      page = (await client.request(HISTORY_FORWARD_QUERY, { id: issueId, after: page.pageInfo.endCursor }, forwardHistoryResult)).issue.history
      entries.push(...page.nodes)
    }
  } else if (history.pageInfo.hasNextPage) {
    // Oldest first: walk back from the end instead.
    let page = (await client.request(HISTORY_BACKWARD_QUERY, { id: issueId }, backwardHistoryResult)).issue.history
    entries.push(...page.nodes)
    for (let pages = 2; page.pageInfo.hasPreviousPage && !reachedSince(page.nodes) && pages < MAX_HISTORY_PAGES; pages++) {
      page = (await client.request(HISTORY_BACKWARD_QUERY, { id: issueId, before: page.pageInfo.startCursor }, backwardHistoryResult)).issue.history
      entries.push(...page.nodes)
    }
  }
  return { current, entries }
}

/**
 * The subscription events a verified webhook stands for: none for anything
 * the direct transport doesn't subscribe to either. Comment and issue
 * webhooks cover the whole workspace. Issue changes that can't concern this
 * app, and its own comments, are dropped without a request; other people's
 * comments still cost one, since a comment's issue doesn't say who it's
 * delegated to. A Linear access error means the entity is gone or out of
 * reach.
 */
export async function linearWebhookEvents(
  client: LinearClient,
  body: LinearWebhookBody,
  appUserId: string,
  /** The app is already working on this issue (it has joined one of its threads). */
  isTracked: (issueId: string) => boolean,
): Promise<DirectSubscriptionEvent[]> {
  const notification = notificationWebhookSchema.safeParse(body)
  if (notification.success) {
    if (notification.data.appUserId !== appUserId) return []
    const { notification: data } = await client.request(NOTIFICATION_QUERY, { id: notification.data.notification.id }, z.object({ notification: directNotificationSchema }))
    return [{ type: 'notificationCreated', data }]
  }

  const comment = commentWebhookSchema.safeParse(body)
  if (comment.success) {
    if (comment.data.action !== 'create' && comment.data.action !== 'update') return []
    // Its own replies never invoke it; comments outside issues aren't followed.
    if (!comment.data.data.issueId || comment.data.data.userId === appUserId) return []
    const { comment: data } = await client.request(COMMENT_QUERY, { id: comment.data.data.id }, z.object({ comment: directCommentSchema }))
    return [{ type: comment.data.action === 'create' ? 'commentCreated' : 'commentUpdated', data }]
  }

  const issue = issueWebhookSchema.safeParse(body)
  if (issue.success && (issue.data.action === 'update' || issue.data.action === 'remove')) {
    const updatedFrom = issue.data.updatedFrom ?? {}
    const wants = historyChanges(issue.data.action, updatedFrom)
    if (!wants.delegate && !wants.state && !wants.archived) return []
    // The same test the live transport applies once it has the event.
    const concernsApp = isTracked(issue.data.data.id) || issue.data.data.delegateId === appUserId || updatedFrom.delegateId === appUserId
    if (!concernsApp) return []
    const changedAt = Date.parse(issue.data.createdAt)
    const { current, entries: history } = await issueHistorySince(client, issue.data.data.id, changedAt - HISTORY_MATCH_WINDOW_MS)
    const nearby = history.filter((entry) => Math.abs(Date.parse(entry.createdAt) - changedAt) <= HISTORY_MATCH_WINDOW_MS)
    // The entry recording exactly this change (same values before and after),
    // nearest in time: a neighbouring change of the same kind, like a
    // delegation withdrawn a moment before this one, must not be replayed.
    const previous = (key: string) => (typeof updatedFrom[key] === 'string' ? updatedFrom[key] : null)
    const kinds: Array<(entry: DirectHistory) => boolean> = []
    if (wants.delegate) kinds.push((entry) => (entry.fromDelegate?.id ?? null) === previous('delegateId') && (entry.toDelegate?.id ?? null) === (issue.data.data.delegateId ?? null))
    if (wants.state) kinds.push((entry) => (entry.fromState?.id ?? null) === previous('stateId') && entry.toState?.id === issue.data.data.stateId)
    if (wants.archived) kinds.push((entry) => entry.archived === true)
    const entries = new Map<string, DirectHistory>()
    for (const matches of kinds) {
      const closest = nearby.filter(matches).sort((a, b) => Math.abs(Date.parse(a.createdAt) - changedAt) - Math.abs(Date.parse(b.createdAt) - changedAt))[0]
      if (closest) entries.set(closest.id, closest)
    }
    // Nothing the live transport would have acted on, or history Linear no
    // longer lists: say so rather than drop it silently.
    if (entries.size === 0) console.warn(`[Linear] No history entry matches the ${issue.data.action} webhook for issue ${issue.data.data.id}`)
    return [...entries.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((entry) => ({ type: 'issueHistoryCreated' as const, data: { ...entry, issue: current } }))
  }
  return []
}

/**
 * Which kinds of issue history the direct transport would act on: delegation
 * (stop when withdrawn), status (runs, or stop on cancel) and archival (stop).
 * Anything else only ever becomes context, which is never input.
 */
function historyChanges(action: string, updatedFrom: Record<string, unknown>) {
  return {
    delegate: 'delegateId' in updatedFrom,
    state: 'stateId' in updatedFrom,
    archived: action === 'remove' || 'archivedAt' in updatedFrom,
  }
}
