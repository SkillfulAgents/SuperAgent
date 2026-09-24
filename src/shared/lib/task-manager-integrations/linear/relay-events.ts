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
  data: z.object({ id: z.string(), delegateId: z.string().nullish() }).loose(),
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
// Either end of the history, whichever order the API returns it in.
const ISSUE_HISTORY_QUERY = `query($id:String!){issue(id:$id){${ISSUE_FIELDS} newest:history(first:25){nodes{${HISTORY_FIELDS}}} oldest:history(last:25){nodes{${HISTORY_FIELDS}}}}}`

const historyNodes = z.object({ nodes: z.array(directHistorySchema) })
const issueHistoryResult = z.object({ issue: directIssueSchema.extend({ newest: historyNodes, oldest: historyNodes }) })

/**
 * The subscription events a verified webhook stands for: none for anything
 * the direct transport doesn't subscribe to either. Comment and issue
 * webhooks cover the whole workspace, so the ones that can't concern this app
 * are dropped before costing a request. A Linear access error means the
 * entity is gone or out of reach.
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
    const { issue: data } = await client.request(ISSUE_HISTORY_QUERY, { id: issue.data.data.id }, issueHistoryResult)
    const { newest, oldest, ...current } = data
    const changedAt = Date.parse(issue.data.createdAt)
    const entries = new Map<string, DirectHistory>()
    for (const entry of [...newest.nodes, ...oldest.nodes]) {
      if (Math.abs(Date.parse(entry.createdAt) - changedAt) > HISTORY_MATCH_WINDOW_MS) continue
      const matches = (wants.delegate && (entry.fromDelegate || entry.toDelegate))
        || (wants.state && entry.toState)
        || (wants.archived && entry.archived)
      if (matches) entries.set(entry.id, entry)
    }
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
