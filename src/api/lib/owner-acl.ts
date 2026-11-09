import { randomUUID } from 'crypto'
import type { Context } from 'hono'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'
import { announceAgentCreated } from '@shared/lib/services/collaboration-events'
import { deleteAgent } from '@shared/lib/services/agent-service'

// Create owner ACL entry when an agent is created in auth mode
async function createOwnerAcl(c: Context, agentSlug: string) {
  if (!isAuthMode()) return
  const userId = getCurrentUserId(c)
  await db.insert(agentAcl).values({
    id: randomUUID(),
    userId,
    agentSlug,
    role: 'owner',
    createdAt: new Date(),
  })
  // Notification streams load the user's agents when they open; this tells
  // the creator's open streams to load again and follow the new agent.
  announceAgentCreated(agentSlug, [userId])
}

// Insert the owner ACL for a just-created agent, rolling back the on-disk
// workspace if the ACL write fails. Agent creation writes the workspace
// (directory + AGENTS.md) before the ACL row exists; without this, a transient
// ACL insert failure would return 500 but leave an orphaned agent directory
// with no owner ACL (SUP-207). The cleanup is best-effort and guarded so a
// failed rollback never masks the original error. In non-auth mode
// createOwnerAcl is a no-op, so this never rolls back there.
export async function createOwnerAclOrRollback(c: Context, agentSlug: string) {
  try {
    await createOwnerAcl(c, agentSlug)
  } catch (error) {
    const userId = getCurrentUserId(c)
    let rolledBack = true
    try {
      await deleteAgent(agentSlug)
    } catch (cleanupError) {
      // Rollback failed: the agent workspace is now orphaned (exists on disk with
      // no owner ACL). This is the worst case and needs operator attention, so
      // report it as a distinct error (the original ACL failure is reported below).
      rolledBack = false
      console.error(`Failed to roll back orphaned agent workspace "${agentSlug}" after owner ACL insert failed:`, cleanupError)
      captureException(cleanupError, {
        tags: { component: 'agents', operation: 'owner-acl-rollback' },
        extra: { agentSlug, userId, originalError: error instanceof Error ? error.message : String(error) },
        level: 'error',
      })
    }
    // Report the ACL insert failure itself. A clean rollback is a recovered
    // failure (warning); a failed rollback left an orphan behind (error).
    captureException(error, {
      tags: { component: 'agents', operation: 'owner-acl-insert' },
      extra: { agentSlug, userId, rolledBack },
      level: rolledBack ? 'warning' : 'error',
    })
    throw error
  }
}
