/**
 * Removes an agent's workspace when the agent is deleted. On this machine the
 * workspace is the agent's directory under the agents data directory. A
 * deployment that keeps workspaces somewhere else sets its own removal at
 * boot, and from then on no directory is touched.
 */
import { getAgentDir, getAgentsDir, removeDirectory } from '@shared/lib/utils/file-storage'
import { assertPathWithinDir } from '@shared/lib/utils/path-safety'
import type { AgentSlug } from './types'

export type WorkspaceRemoval = (slug: AgentSlug) => Promise<void>

let removal: WorkspaceRemoval | undefined

/**
 * How this deployment removes an agent's workspace, in place of the directory
 * on this machine. Called once at boot; null puts the directory back. A
 * removal that rejects fails the delete, which keeps the agent, so it can be
 * tried again.
 */
export function setWorkspaceRemoval(remove: WorkspaceRemoval | null): void {
  removal = remove ?? undefined
}

export async function removeAgentWorkspace(slug: AgentSlug): Promise<void> {
  if (removal) return removal(slug)
  const dir = getAgentDir(slug)
  assertPathWithinDir(getAgentsDir(), dir)
  await removeDirectory(dir)
}
