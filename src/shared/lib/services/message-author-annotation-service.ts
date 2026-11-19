/**
 * Who sent the user messages in a response, joined on from `message_author`
 * in one statement: an integration's card (`integration`) and, when asked for,
 * the person's profile (`sender`).
 *
 * The statement binds a fixed number of parameters however many messages the
 * response holds. The ids travel as one JSON array read with `json_each`, not
 * as an `IN (?, ?, …)` list: Cloudflare D1 allows 100 bound parameters per
 * statement and a page holds up to 500 messages.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor, user } from '@shared/lib/db/schema'
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
 * fields. `ids` narrows it to those messages; it is bound as one parameter.
 * Exported for the test that pins the parameter count.
 */
export function messageAuthorsQuery(sessionId: string, ids: readonly string[] | null) {
  return db
    .select({
      id: messageAuthor.id,
      agentSlug: messageAuthor.agentSlug,
      integrationId: messageAuthor.integrationId,
      display: messageAuthor.display,
      profile: userProfileFields(),
    })
    .from(messageAuthor)
    .leftJoin(user, eq(user.id, messageAuthor.userId))
    .where(and(
      eq(messageAuthor.sessionId, sessionId),
      ids ? inArray(messageAuthor.id, sql`(select value from json_each(${JSON.stringify(ids)}))`) : undefined,
    ))
}

type UserItem = Extract<TransformedItem, { type: 'user' | 'assistant' }>

export interface AnnotateMessageAuthorsOptions {
  /** Attach `sender` to messages a person wrote (auth mode). */
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
 * Attach `integration` and `sender` to the user messages in a response, by
 * transcript id. A card is only joined to a message of the agent it was
 * recorded for, and one that no longer validates is skipped: that message
 * renders as text. A message whose author has no user row gets no sender.
 */
export async function annotateMessageAuthors(
  agentSlug: string,
  sessionId: string,
  items: readonly (TransformedItem | null | undefined)[],
  options: AnnotateMessageAuthorsOptions,
): Promise<void> {
  const users = items.filter((item): item is UserItem => !!item && item.type === 'user')
  if (users.length === 0) return

  const rows = await messageAuthorsQuery(sessionId, options.scope === 'session' ? null : users.map(item => item.id)).all()

  const byId = new Map(rows.map(row => [row.id, row]))
  for (const item of users) {
    const row = byId.get(item.id)
    if (!row) continue
    if (row.integrationId !== null && row.agentSlug === agentSlug) {
      const display = parseDisplay(row.display)
      if (display) item.integration = display
    }
    if (options.senders && row.profile) item.sender = toUserProfile(row.profile)
  }
}
