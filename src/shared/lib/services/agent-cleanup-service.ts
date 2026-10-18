import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import {
  agentConnectedAccounts,
  agentBrowserCredentials,
  webhookTriggers,
  chatIntegrations,
  scheduledTasks,
  notifications,
  sessionUnreadMarks,
  agentRemoteMcps,
  proxyAuditLog,
  mcpAuditLog,
  agentAcl,
  messageAuthor,
  proxyRules,
} from '@shared/lib/db/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { cancelWebhookTriggerWithCleanup } from '@shared/lib/services/webhook-trigger-service'
import { unlinkAgentStatements } from '@shared/lib/services/todo-service'
import { invalidateRuleCache } from '@shared/lib/proxy/rules/store'
import { auditRuleChange, rulesAboutToBeRemoved } from '@shared/lib/proxy/rules/audit-events'

export async function cleanupAgentData(agentSlug: string): Promise<void> {
  await cleanupWebhookTriggers(agentSlug)
  const { cleanupIntegrationResources } = await import('../agent-integrations/cleanup')
  await cleanupIntegrationResources(agentSlug)
  const scopedRules = await rulesAboutToBeRemoved({ agentSlug })

  // Delete all peripheral rows in one batch so the cleanup is atomic: either
  // every row referencing this agent is removed or none is, never a
  // half-cleaned state (SUP-208).
  await batch([
    db.delete(chatIntegrations).where(eq(chatIntegrations.agentSlug, agentSlug)),
    db.delete(scheduledTasks).where(eq(scheduledTasks.agentSlug, agentSlug)),
    db.delete(notifications).where(eq(notifications.agentSlug, agentSlug)),
    db.delete(sessionUnreadMarks).where(eq(sessionUnreadMarks.agentSlug, agentSlug)),
    db.delete(agentConnectedAccounts).where(eq(agentConnectedAccounts.agentSlug, agentSlug)),
    db.delete(agentBrowserCredentials).where(eq(agentBrowserCredentials.agentSlug, agentSlug)),
    db.delete(agentRemoteMcps).where(eq(agentRemoteMcps.agentSlug, agentSlug)),
    db.delete(proxyAuditLog).where(eq(proxyAuditLog.agentSlug, agentSlug)),
    db.delete(mcpAuditLog).where(eq(mcpAuditLog.agentSlug, agentSlug)),
    // Agent-scoped proxy rules (versions cascade); a later agent reusing the
    // slug must not inherit them. Account-wide rules stay.
    db.delete(proxyRules).where(eq(proxyRules.agentSlug, agentSlug)),
    db.delete(agentAcl).where(eq(agentAcl.agentSlug, agentSlug)),
    db.delete(messageAuthor).where(eq(messageAuthor.agentSlug, agentSlug)),
    // Todo board items outlive the agent: they let go of it instead.
    ...unlinkAgentStatements(agentSlug),
  ])
  invalidateRuleCache()
  for (const rule of scopedRules) await auditRuleChange('deleted', rule, { by: 'system', reason: 'agent_deleted' })
}

// Delegates per-trigger cancel + upstream teardown to the shared path so the
// minting-member-attributed delete (SUP-765) applies to agent deletion too.
async function cleanupWebhookTriggers(agentSlug: string): Promise<void> {
  const triggers = await db
    .select({ id: webhookTriggers.id })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.agentSlug, agentSlug),
        inArray(webhookTriggers.status, ['active', 'paused']),
      ),
    )
    .all()

  for (const { id } of triggers) {
    await cancelWebhookTriggerWithCleanup(id)
  }
}
