/**
 * Who sent the user messages in a response, joined on from `message_author`
 * in one statement: an integration's card (`integration`) and, when asked for,
 * the person's profile (`sender`) or the calling agent (`agentSender`).
 *
 * A page holds up to 500 messages. The ID filter shares the driver’s
 * parameter budget with the agent slug and session ID.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { inList } from '@shared/lib/db/bound-parameters'
import { agents, messageAuthor, user } from '@shared/lib/db/schema'
import { agentAvatarSchema } from '@shared/lib/types/agent-avatar'
import { integrationMessageDisplaySchema, type IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'
import { toUserProfile, userProfileFields } from '@shared/lib/services/user-profile-service'
import type { TransformedItem } from '@shared/lib/utils/message-transform'

function parseDisplay(json: string | null): IntegrationMessageDisplay | null {
  if (!json) return null
  try {
    const parsed = integrationMessageDisplaySchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The one read: the session's author rows, each with its user's profile
 * fields. An ID list narrows the read to those messages.
 * Exported for the test that pins the parameter count.
 */
export function messageAuthorsQuery(agentSlug: string, sessionId: string, ids: readonly string[] | null) {
  return db
    .select({
      id: messageAuthor.id,
      authorAgentSlug: messageAuthor.authorAgentSlug,
      agent: { name: agents.name, color: agents.avatarColor, shape: agents.avatarShape },
      integrationId: messageAuthor.integrationId,
      display: messageAuthor.display,
      profile: userProfileFields(),
    })
    .from(messageAuthor)
    .leftJoin(user, eq(user.id, messageAuthor.userId))
    .leftJoin(agents, eq(agents.slug, messageAuthor.authorAgentSlug))
    .where(and(
      eq(messageAuthor.agentSlug, agentSlug),
      eq(messageAuthor.sessionId, sessionId),
      ids ? inList(messageAuthor.id, ids, { otherParams: 2 }) : undefined,
    ))
}

type UserItem = Extract<TransformedItem, { type: 'user' | 'assistant' }>

export interface AnnotateMessageAuthorsOptions {
  /** Attach the person or agent that sent the message (auth mode). */
  senders: boolean
  /**
   * Which rows to read. `items` (the default) reads the rows of the messages
   * in hand, so a delta of three messages reads three rows. `session` reads
   * the session's rows with no id list, for a response that is the whole
   * transcript.
   */
  scope?: 'items' | 'session'
}

/**
 * Attach the sender recorded for this recipient and transcript. A full import
 * can carry the same session and message IDs into another agent's workspace.
 */
export async function annotateMessageAuthors(
  agentSlug: string,
  sessionId: string,
  items: readonly (TransformedItem | null | undefined)[],
  options: AnnotateMessageAuthorsOptions,
): Promise<void> {
  const users = items.filter((item): item is UserItem => !!item && item.type === 'user')
  if (users.length === 0) return

  const rows = await messageAuthorsQuery(agentSlug, sessionId, options.scope === 'session' ? null : users.map(item => item.id)).all()

  const byId = new Map(rows.map(row => [row.id, row]))
  for (const item of users) {
    const row = byId.get(item.id)
    if (!row) continue
    if (row.integrationId !== null) {
      const display = parseDisplay(row.display)
      if (display) item.integration = display
    } else if (options.senders && row.authorAgentSlug) {
      const avatar = row.agent && agentAvatarSchema.safeParse({ color: row.agent.color, shape: row.agent.shape }).data
      item.agentSender = { slug: row.authorAgentSlug, name: row.agent?.name ?? row.authorAgentSlug, avatar: avatar ?? null }
    } else if (options.senders && row.profile) {
      item.sender = toUserProfile(row.profile)
    }
  }
}
