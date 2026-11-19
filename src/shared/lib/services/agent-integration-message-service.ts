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

import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { messageAuthor } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'
import { integrationMessageDisplaySchema, type IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'

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
