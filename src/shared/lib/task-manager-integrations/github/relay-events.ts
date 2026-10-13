import { createHmac, timingSafeEqual } from 'node:crypto'
import { webhookEnvelopeSchema } from '../../services/webhook-endpoint-schema'
import type { RelayEvent } from '../../webhook-relay'
import type { TaskEvent } from '../types'
import { githubWebhookSchema, type GitHubWebhook } from './api-schema'

/** Verify the exact bytes forwarded by the relay before interpreting any content. */
export function readGitHubWebhook(event: RelayEvent, secret: string): { type: string; deliveryId: string; body: GitHubWebhook } | null {
  const envelope = webhookEnvelopeSchema.safeParse(event.payload)
  if (!envelope.success || envelope.data.kind !== 'event' || envelope.data.body === undefined) return null
  const { body, body_encoding: encoding, headers = {} } = envelope.data
  if (encoding && !['utf8', 'base64'].includes(encoding)) return null
  const raw = Buffer.from(body, encoding === 'base64' ? 'base64' : 'utf8')
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
  const supplied = Buffer.from(headers['x-hub-signature-256'] ?? '')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
  const deliveryId = headers['x-github-delivery']
  const type = headers['x-github-event']
  if (!deliveryId || !type) return null
  try { return { deliveryId, type, body: githubWebhookSchema.parse(JSON.parse(raw.toString('utf8'))) } }
  catch { return null }
}

/** An exact handle, outside code fences/inline code. Never match another app's prefix. */
export function mentionsGitHubApp(text: string, slug: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\w@])@${escaped}(?:\\[bot\\])?(?![\\w-]|\\[)`, 'i').test(prose)
}

export function githubTaskEvent(type: string, deliveryId: string, body: GitHubWebhook, slug: string, followed: boolean): TaskEvent | null {
  const issue = body.issue ?? body.pull_request
  const repository = body.repository
  if (!repository || !issue || !body.sender || body.sender.type === 'Bot' || body.sender.login.toLowerCase() === `${slug}[bot]`.toLowerCase()) return null
  const ordinary = type === 'issue_comment'
  const inline = type === 'pull_request_review_comment'
  const review = type === 'pull_request_review'
  const comment = ordinary || inline ? body.comment : undefined
  const supported = comment ? ['created', 'edited'].includes(body.action ?? '')
    : review ? body.action === 'submitted' && !!body.review
    : ['issues', 'pull_request'].includes(type) && ['opened', 'edited'].includes(body.action ?? '')
  if (!supported) return null
  const text = comment?.body ?? (review ? body.review?.body : issue.body) ?? ''
  const mentioned = mentionsGitHubApp(text, slug)
  // An edit without a new mention is context; only newly posted follow-ups run.
  if (!mentioned && !(followed && (comment && body.action === 'created' || review && body.action === 'submitted'))) return null
  const taskId = `${repository.owner.login}/${repository.name}#${issue.number}`
  return {
    id: `github:${deliveryId}`, taskId, interactionId: String(comment?.id ?? body.review?.id ?? issue.id),
    kind: 'invocation', trigger: mentioned ? (comment || review ? 'comment_mention' : 'mentioned') : 'comment',
    timestamp: comment?.updated_at ?? body.review?.submitted_at ?? issue.updated_at,
    title: `${taskId}: ${issue.title}`, text,
    sourceCommentId: comment ? String(comment.id) : undefined,
    replyTarget: inline && comment ? { commentId: String(comment.in_reply_to_id ?? comment.id) } : {},
    payload: { issue, comment, review: body.review, sender: body.sender, repository, type },
  }
}
