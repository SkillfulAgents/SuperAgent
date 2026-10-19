import type { Context } from 'hono'
import { isAuthMode } from '@shared/lib/auth/mode'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { captureException } from '@shared/lib/error-reporting'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import { listAgentMembers } from '@shared/lib/services/agent-members-service'
import type { Mention } from '@shared/lib/utils/mentions'
import { parseUserMessageParts } from '@shared/lib/utils/user-message-parts'

type TaggedTeammate = Extract<Mention, { kind: 'user' }>

export interface SessionMentions {
  /** The teammates the message tags: each once, never its sender. */
  teammates: TaggedTeammate[]
  /** The message opens on a teammate, so it only notifies: no turn runs. */
  silent: boolean
  /** The message as its bubble shows it, for the notification. */
  text: string
}

interface Sender { id: string; name: string; email: string }

/**
 * Read who a message tags. Teammates exist in auth mode only, and each one it
 * tags must already be able to open the agent: the composer offers to share
 * it first, so anything else is refused.
 */
export async function readSessionMentions(
  c: Context,
  agentSlug: string,
  content: string,
): Promise<SessionMentions | { error: string }> {
  const parts = parseUserMessageParts(content)
  if (!isAuthMode()) return { teammates: [], silent: false, text: parts.text }

  const sender = c.get('user' as never) as Sender
  const tagged = new Map<string, TaggedTeammate>()
  for (const mention of parts.mentions) {
    if (mention.kind === 'user' && mention.id !== sender.id) tagged.set(mention.id, mention)
  }
  const teammates = [...tagged.values()]
  if (teammates.length > 0) {
    const members = new Set((await listAgentMembers(agentSlug)).map((member) => member.id))
    const outside = teammates.filter((teammate) => !members.has(teammate.id))
    if (outside.length > 0) {
      return { error: `${outside.map((teammate) => teammate.name).join(', ')} can't open this agent. Share it with them first.` }
    }
  }
  return { teammates, silent: parts.silent && teammates.length > 0, text: parts.text }
}

/**
 * Tell each tagged teammate, once the message is in the transcript. Best-effort:
 * the message is already sent, so a failure here is logged, not returned.
 */
export async function notifySessionMentions(
  c: Context,
  mentions: SessionMentions,
  message: { agentSlug: string; agentName: string; sessionId: string; sessionName?: string; messageUuid: string },
): Promise<void> {
  if (mentions.teammates.length === 0) return
  const sender = c.get('user' as never) as Sender
  const members = new Map((await listAgentMembers(message.agentSlug).catch(() => [])).map((member) => [member.id, member]))
  const sessionPath = `/agents/${encodeURIComponent(message.agentSlug)}/sessions/${encodeURIComponent(message.sessionId)}`

  for (const teammate of mentions.teammates) {
    try {
      await notificationManager.triggerSessionMention({
        sessionId: message.sessionId,
        agentSlug: message.agentSlug,
        messageUuid: message.messageUuid,
        recipientUserId: teammate.id,
        senderName: sender.name,
        text: mentions.text,
      })
    } catch (error) {
      captureException(error, { tags: { component: 'agents', operation: 'notify-mention' }, level: 'warning' })
      continue
    }
    const taggee = members.get(teammate.id)
    const properties = {
      taggerId: sender.id,
      taggerName: sender.name,
      taggerEmail: sender.email,
      taggeeId: teammate.id,
      taggeeName: taggee?.name ?? teammate.name,
      taggeeEmail: taggee?.email,
      messageContent: mentions.text,
      messageUuid: message.messageUuid,
      agentSlug: message.agentSlug,
      agentName: message.agentName,
      sessionId: message.sessionId,
      sessionName: message.sessionName,
      sessionPath,
    }
    trackServerEvent('tagged_in_session', properties, teammate.id, taggee?.email ? { email: taggee.email } : undefined)
    trackServerEvent('added_user_tag_in_session', properties, sender.id)
  }
}
