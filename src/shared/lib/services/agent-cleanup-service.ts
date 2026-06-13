import { db } from '@shared/lib/db'
import {
  agentConnectedAccounts,
  webhookTriggers,
  chatIntegrations,
  scheduledTasks,
  notifications,
  agentRemoteMcps,
  proxyAuditLog,
  mcpAuditLog,
  agentAcl,
  messageAuthor,
} from '@shared/lib/db/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { deleteComposioTrigger } from '@shared/lib/composio/triggers'
import { isPlatformComposioActive } from '@shared/lib/composio/client'

export async function cleanupAgentData(agentSlug: string): Promise<void> {
  await cleanupWebhookTriggers(agentSlug)

  // Delete all peripheral rows in a single transaction so the cleanup is atomic:
  // either every row referencing this agent is removed or none is, never a
  // half-cleaned state (SUP-208).
  db.transaction(() => {
    db.delete(chatIntegrations).where(eq(chatIntegrations.agentSlug, agentSlug)).run()
    db.delete(scheduledTasks).where(eq(scheduledTasks.agentSlug, agentSlug)).run()
    db.delete(notifications).where(eq(notifications.agentSlug, agentSlug)).run()
    db.delete(agentConnectedAccounts).where(eq(agentConnectedAccounts.agentSlug, agentSlug)).run()
    db.delete(agentRemoteMcps).where(eq(agentRemoteMcps.agentSlug, agentSlug)).run()
    db.delete(proxyAuditLog).where(eq(proxyAuditLog.agentSlug, agentSlug)).run()
    db.delete(mcpAuditLog).where(eq(mcpAuditLog.agentSlug, agentSlug)).run()
    db.delete(agentAcl).where(eq(agentAcl.agentSlug, agentSlug)).run()
    db.delete(messageAuthor).where(eq(messageAuthor.agentSlug, agentSlug)).run()
  })
}

async function cleanupWebhookTriggers(agentSlug: string): Promise<void> {
  const triggers = db
    .select()
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.agentSlug, agentSlug),
        inArray(webhookTriggers.status, ['active', 'paused']),
      ),
    )
    .all()

  for (const trigger of triggers) {
    db.update(webhookTriggers)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(webhookTriggers.id, trigger.id))
      .run()

    if (trigger.composioTriggerId && isPlatformComposioActive()) {
      const remaining = db
        .select()
        .from(webhookTriggers)
        .where(
          and(
            eq(webhookTriggers.composioTriggerId, trigger.composioTriggerId),
            inArray(webhookTriggers.status, ['active', 'paused']),
          ),
        )
        .all().length

      if (remaining === 0) {
        try {
          await deleteComposioTrigger(trigger.composioTriggerId)
        } catch (error) {
          console.error('[agent-cleanup] Failed to delete Composio trigger:', error)
        }
      }
    }
  }
}
