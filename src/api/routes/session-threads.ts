import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { AgentRead, AgentUser, getAgentId } from '../middleware/auth'
import { agentRegistry } from '@shared/lib/agent-actor'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { listAgentMembers } from '@shared/lib/services/agent-members-service'
import {
  THREAD_REPLIES_UPDATED_EVENT,
  THREAD_REPLY_MAX,
  threadRepliesResponseSchema,
  threadReplyBodySchema,
  threadSummariesResponseSchema,
} from '@shared/lib/session-threads/thread-schema'
import {
  addThreadReply,
  getMessageAuthorUserId,
  listThreadParticipants,
  listThreadReplies,
  listThreadSummaries,
} from '@shared/lib/session-threads/thread-service'

/**
 * Threads on a session's messages (Slack's "reply in thread"). Mounted at
 * /api/agents/:id/sessions/:sessionId/threads, after Authenticated() and
 * ResolveAgent(). Replies never reach the agent's transcript: sharing a thread
 * with the agent is an ordinary message, sent from the drawer.
 *
 * Auth mode only: a thread is between teammates, who exist nowhere else.
 */
const sessionThreadRoutes = new Hono()

interface Sender { id: string; name: string }

async function sessionIsKnown(agentSlug: string, sessionId: string): Promise<boolean> {
  return agentRegistry.get(agentSlug).sessions.isKnown(sessionId)
}

// GET / - every thread in the session that has a reply
sessionThreadRoutes.get('/', AgentRead(), async (c) => {
  if (!isAuthMode()) return c.json(threadSummariesResponseSchema.parse({ threads: [] }))
  const agentSlug = getAgentId(c)
  const sessionId = c.req.param('sessionId')!
  if (!(await sessionIsKnown(agentSlug, sessionId))) return c.json({ error: 'Session not found' }, 404)
  return c.json(threadSummariesResponseSchema.parse({ threads: await listThreadSummaries(agentSlug, sessionId) }))
})

// GET /:parentMessageUuid - one thread's replies, oldest first
sessionThreadRoutes.get('/:parentMessageUuid', AgentRead(), async (c) => {
  if (!isAuthMode()) return c.notFound()
  const agentSlug = getAgentId(c)
  const sessionId = c.req.param('sessionId')!
  if (!(await sessionIsKnown(agentSlug, sessionId))) return c.json({ error: 'Session not found' }, 404)
  const replies = await listThreadReplies({ agentSlug, sessionId, parentMessageUuid: c.req.param('parentMessageUuid') })
  return c.json(threadRepliesResponseSchema.parse({ replies }))
})

// POST /:parentMessageUuid/replies - reply in the thread, telling everyone in it
sessionThreadRoutes.post(
  '/:parentMessageUuid/replies',
  AgentUser(),
  bodyLimit({ maxSize: THREAD_REPLY_MAX * 4 + 16 * 1024 }),
  zValidator('json', threadReplyBodySchema),
  async (c) => {
    if (!isAuthMode()) return c.notFound()
    const agentSlug = getAgentId(c)
    const sessionId = c.req.param('sessionId')!
    const parentMessageUuid = c.req.param('parentMessageUuid')
    if (!(await sessionIsKnown(agentSlug, sessionId))) return c.json({ error: 'Session not found' }, 404)
    // A thread hangs off a message a person wrote in this session.
    if (!(await getMessageAuthorUserId(agentSlug, sessionId, parentMessageUuid))) {
      return c.json({ error: 'Message not found' }, 404)
    }

    const sender = c.get('user' as never) as Sender
    const userId = getCurrentUserId(c)
    const body = c.req.valid('json')
    const members = new Set((await listAgentMembers(agentSlug)).map((member) => member.id))
    const key = { agentSlug, sessionId, parentMessageUuid }

    const reply = await addThreadReply({
      ...key,
      userId,
      text: body.text,
      taggedUserIds: body.taggedUserIds.filter((id) => members.has(id)),
    })

    // Everyone the thread involves who can still open the agent, but not
    // the person replying. Best-effort: the reply is already saved.
    const recipients = (await listThreadParticipants(key)).filter((id) => id !== userId && members.has(id))
    for (const recipientUserId of recipients) {
      try {
        await notificationManager.triggerThreadReply({
          sessionId, agentSlug, replyId: reply.id, recipientUserId, senderName: sender.name, text: body.text,
        })
      } catch (error) {
        captureException(error, { tags: { component: 'session-threads', operation: 'notify-reply' }, level: 'warning' })
      }
    }
    // Every window on the session redraws the thread and its row.
    background(
      agentRegistry.get(agentSlug).messages.broadcastEvent(sessionId, { type: THREAD_REPLIES_UPDATED_EVENT, parentMessageUuid }),
      { name: 'session-threads.broadcast-reply' },
    )
    // No names or text: analytics must not carry PII.
    trackServerEvent('thread_reply_sent', {
      agentSlug, sessionId, parentMessageUuid, replyLength: body.text.length, recipientCount: recipients.length,
    })

    return c.json({ id: reply.id, createdAt: reply.createdAt.toISOString() }, 201)
  },
)

export default sessionThreadRoutes
