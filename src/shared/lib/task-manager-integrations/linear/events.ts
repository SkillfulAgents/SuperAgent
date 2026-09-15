import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { webhookEnvelopeSchema } from '../../services/webhook-endpoint-schema'
import type { TaskEvent } from '../types'
import type { LinearConfig } from './config'

const resourceSchema = z.object({
  id: z.string().optional(), issueId: z.string().nullish(), issue: z.object({ id: z.string() }).nullish(),
  title: z.string().optional(), identifier: z.string().optional(), body: z.string().optional(), userId: z.string().nullish(),
  delegateId: z.string().nullish(), updatedAt: z.string().optional(),
}).passthrough()
const webhookSchema = z.object({
  type: z.string(), action: z.string(), organizationId: z.string(), webhookTimestamp: z.number(),
  appUserId: z.string().optional(), oauthClientId: z.string().optional(), userId: z.string().optional(), activeTokensForUser: z.number().optional(),
  actor: z.object({ id: z.string(), type: z.string().optional() }).optional(),
  data: resourceSchema.optional(), updatedFrom: z.record(z.string(), z.unknown()).optional(),
  agentSession: z.object({ id: z.string(), appUserId: z.string(), issueId: z.string().nullish(),
    issue: z.object({ id: z.string(), title: z.string().optional(), identifier: z.string().optional() }).nullish() }).optional(),
  agentActivity: z.object({ id: z.string(), signal: z.string().nullish(), userId: z.string().optional(),
    content: z.object({ type: z.string().optional(), body: z.string().optional() }).optional(), body: z.string().optional() }).optional(),
  promptContext: z.string().optional(),
}).passthrough()
export type LinearWebhook = z.infer<typeof webhookSchema>

/** Validate against relay receipt time, not poll time: signed events may wait while the host sleeps. */
export function verifiedLinearWebhook(envelope: unknown, secret: string): LinearWebhook | null {
  const parsed = webhookEnvelopeSchema.safeParse(envelope)
  if (!parsed.success || parsed.data.kind !== 'event' || !parsed.data.verified || !parsed.data.body || !parsed.data.received_at) return null
  const data = parsed.data
  if (data.body_encoding && !['utf8', 'base64'].includes(data.body_encoding)) return null
  const body = Buffer.from(data.body!, data.body_encoding === 'base64' ? 'base64' : 'utf8')
  if (body.length > 2 * 1024 * 1024) return null
  const signature = Object.entries(data.headers ?? {}).find(([key]) => key.toLowerCase() === 'linear-signature')?.[1]
  if (!signature || !/^[a-f\d]{64}$/i.test(signature)) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null
  try {
    const payload = webhookSchema.parse(JSON.parse(body.toString('utf8')))
    const receivedAt = Date.parse(data.received_at!)
    if (!Number.isFinite(receivedAt) || Math.abs(receivedAt - payload.webhookTimestamp) > 60000) return null
    return payload
  } catch { return null }
}
export type LinearAction = { type: 'event'; event: TaskEvent } | { type: 'stop'; taskId: string; interactionId?: string } | { type: 'revoke' } | { type: 'permissions' }
export function normalizeLinearWebhook(payload: LinearWebhook, config: LinearConfig, isTracked: (id: string) => boolean): LinearAction | null {
  const identity = config.identity
  if (!identity || payload.organizationId !== identity.workspaceId) return null
  if (payload.oauthClientId && payload.oauthClientId !== config.clientId) return null
  if (payload.appUserId && payload.appUserId !== identity.appUserId) return null
  if (payload.type === 'OAuthAuthorization') {
    if (payload.webhookTimestamp < (config.authorizedAt ?? 0)) return null
    return payload.userId === identity.appUserId && payload.activeTokensForUser === 0 ? { type: 'revoke' } : null
  }
  if (payload.type === 'PermissionChange') return { type: 'permissions' }
  if (payload.type === 'AgentSessionEvent') {
    const session = payload.agentSession
    const taskId = session?.issueId ?? session?.issue?.id
    if (!session || session.appUserId !== identity.appUserId || !taskId) return null
    const activity = payload.agentActivity
    if (activity?.signal === 'stop') return { type: 'stop', taskId, interactionId: session.id }
    if (activity?.userId === identity.appUserId) return null
    if (payload.action !== 'created' && payload.action !== 'prompted') return null
    if (payload.action === 'prompted' && (!activity?.id || (activity.content?.type && activity.content.type !== 'prompt'))) return null
    return { type: 'event', event: { id: payload.action === 'created' ? `created:${session.id}` : `prompted:${activity!.id}`,
      taskId, interactionId: session.id, kind: 'invocation', acknowledge: true, timestamp: new Date(payload.webhookTimestamp).toISOString(),
      text: activity?.content?.body ?? activity?.body ?? payload.promptContext ?? 'Review this issue and respond to the request that delegated or mentioned you.',
      title: [session.issue?.identifier, session.issue?.title].filter(Boolean).join(': ') || undefined, replyTarget: { agentSessionId: session.id }, payload } }
  }
  const data = payload.data
  const taskId = payload.type === 'Issue' ? data?.id : data?.issueId ?? data?.issue?.id
  if (!taskId || !isTracked(taskId)) return null
  if (payload.actor?.id === identity.appUserId || payload.actor?.id === config.clientId || data?.userId === identity.appUserId) return null
  if (payload.type === 'Issue' && (payload.action === 'remove' || (payload.updatedFrom && 'delegateId' in payload.updatedFrom && data?.delegateId !== identity.appUserId))) {
    return { type: 'stop', taskId }
  }
  if (!['Issue', 'Comment', 'Attachment'].includes(payload.type)) return null
  const statusChange = payload.type === 'Issue' && payload.action === 'update' && payload.updatedFrom && 'stateId' in payload.updatedFrom
  // Ignore the subscription ID: it is shared by every delivery. A stable body
  // hash deduplicates ordinary resource updates; native sessions use semantic IDs.
  const id = createHash('sha256').update(JSON.stringify({ type: payload.type, action: payload.action, data, updatedFrom: payload.updatedFrom })).digest('hex')
  return { type: 'event', event: { id, taskId, interactionId: '', kind: statusChange && config.runOnStatusChange ? 'status' : 'context',
    timestamp: new Date(payload.webhookTimestamp).toISOString(), title: data?.title,
    text: `${payload.type} ${payload.action}${statusChange ? ': issue status changed' : ''}`, replyTarget: {}, payload } }
}
