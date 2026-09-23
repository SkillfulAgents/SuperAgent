/**
 * Agent Integration Message Service — integration authorship of user messages.
 *
 * A message an integration delivered has a `message_author` row naming the
 * integration instead of a user, keyed by the uuid it was sent with, and the
 * row carries the card the app draws for it. The transcript keeps exactly the
 * text the agent received. The messages API joins cards back on by uuid alone:
 * the CLI keeps the uuid for a message queued mid-turn too (as the
 * queued_command's source_uuid, which becomes its transcript id). Only the host
 * writes rows and mints their uuids, so no message — whatever its text — can
 * claim another's card. Session, agent and fork handling are message_author's.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'
import { integrationMessageDisplaySchema, type IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'
import type { TransformedItem } from '@shared/lib/utils/message-transform'

// D1 caps bound parameters per statement; keep each IN list well under it.
const IN_LIST_CHUNK = 80

export interface IntegrationMessageRecord {
  /** The uuid the message is sent with, which becomes its transcript id. */
  id: string
  sessionId: string
  agentSlug: string
  display: IntegrationMessageDisplay
}

/**
 * Record the integration as a message's author, with its card, and return the
 * stored card. Best-effort: a failure (or a card that does not validate)
 * leaves the message rendering as plain text, never blocks delivery.
 */
export async function recordIntegrationMessage(record: IntegrationMessageRecord): Promise<IntegrationMessageDisplay | null> {
  try {
    const display = integrationMessageDisplaySchema.parse(record.display)
    const row = {
      sessionId: record.sessionId,
      agentSlug: record.agentSlug,
      userId: null,
      integrationId: display.integration.id,
      display: JSON.stringify(display),
    }
    // A retried delivery re-records under the same uuid, possibly into a new
    // session after self-heal: the latest attempt's session wins.
    await db.insert(messageAuthor).values({ id: record.id, ...row })
      .onConflictDoUpdate({ target: messageAuthor.id, set: row })
    return display
  } catch (error) {
    captureException(error, {
      tags: { component: 'agent-integration', operation: 'record-message-display' },
      extra: { agentSlug: record.agentSlug, provider: record.display.integration?.provider },
      level: 'warning',
    })
    return null
  }
}

export async function hasIntegrationMessages(agentSlug: string, sessionId: string): Promise<boolean> {
  const row = await db.select({ id: messageAuthor.id }).from(messageAuthor)
    .where(and(eq(messageAuthor.agentSlug, agentSlug), eq(messageAuthor.sessionId, sessionId), isNotNull(messageAuthor.integrationId)))
    .limit(1)
    .get()
  return !!row
}

function parseDisplay(json: string | null): IntegrationMessageDisplay | null {
  if (!json) return null
  try {
    const parsed = integrationMessageDisplaySchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

type UserItem = Extract<TransformedItem, { type: 'user' | 'assistant' }>

/**
 * Attach `integration` to the user messages in a response, by transcript id.
 * Rows that no longer validate are skipped: that message renders as text.
 */
export async function annotateIntegrationMessages(
  agentSlug: string,
  sessionId: string,
  items: readonly (TransformedItem | null | undefined)[],
): Promise<void> {
  const users = items.filter((item): item is UserItem => !!item && item.type === 'user')
  if (users.length === 0) return

  const displays = new Map<string, string | null>()
  const ids = users.map(item => item.id)
  for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
    const rows = await db.select({ id: messageAuthor.id, display: messageAuthor.display })
      .from(messageAuthor)
      .where(and(
        eq(messageAuthor.agentSlug, agentSlug),
        eq(messageAuthor.sessionId, sessionId),
        isNotNull(messageAuthor.integrationId),
        inArray(messageAuthor.id, ids.slice(i, i + IN_LIST_CHUNK)),
      ))
      .all()
    for (const row of rows) displays.set(row.id, row.display)
  }
  for (const item of users) {
    const display = parseDisplay(displays.get(item.id) ?? null)
    if (display) item.integration = display
  }
}
