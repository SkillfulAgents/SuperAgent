import { revokeProxyToken } from '@shared/lib/proxy/token-store'
import { cleanupAgentData } from '@shared/lib/services/agent-cleanup-service'
import { deleteAgent } from '@shared/lib/services/agent-service'
import { deletePoliciesForAgent } from '@shared/lib/services/x-agent-policy-service'
import { stopInstanceOnAllProviders } from '../../main/host-browser'
import { deleteBrowserProfile } from '../../main/host-browser/profile-maintenance'

/**
 * Remove an agent and what it leaves behind: its proxy token, its x-agent
 * policies, its peripheral data, its workspace and its host-browser profile.
 * False when the agent was already gone. Throws AgentContainerStopError when
 * its container cannot be stopped; the workspace is then kept and a retry
 * finishes the removal.
 */
export async function removeAgent(slug: string): Promise<boolean> {
  // Best-effort: a revoked token is harmless on its own.
  try {
    await revokeProxyToken(slug)
  } catch (error) {
    console.error('Failed to revoke proxy token:', error)
  }

  // x-agent invoke policies referencing this agent (caller or target).
  await deletePoliciesForAgent(slug)

  // Triggers, integrations, tasks, ACLs, etc. BEFORE the irreversible
  // workspace removal: if any peripheral cleanup throws, the workspace is
  // still intact, so the removal is safely retryable instead of leaving
  // orphaned rows pointing at a workspace that no longer exists (SUP-208).
  await cleanupAgentData(slug)

  // Irreversible, so last: it only happens once every cleanup above succeeded.
  // The container is stopped, and its runtime forgotten, inside deleteAgent.
  if (!(await deleteAgent(slug))) return false

  // The container teardown only stops the browser on the ACTIVE provider (a
  // Chrome launched before the user switched providers survives it), so stop
  // this agent's browser on every provider first. deleteBrowserProfile refuses
  // profiles claimed by an in-flight launch. Best-effort throughout: a
  // leftover dir is reclaimed by a later startup sweep.
  try {
    await stopInstanceOnAllProviders(slug)
    await deleteBrowserProfile(slug)
  } catch (error) {
    console.error('Failed to delete host-browser profile:', error)
  }
  return true
}
