/**
 * Which agents exist on this machine: the directory scan under the agents
 * data directory, and the id minting and resolution that go with it. Host
 * level, like the container host — an actor is about one agent, and this is
 * about the set.
 */
import {
  directoryExists,
  ensureDirectory,
  generateAgentId,
  getAgentDir,
  getAgentsDir,
  listDirectories,
  removeDirectory,
  resolveAgentId,
} from '@shared/lib/utils/file-storage'
import type { AgentCatalog } from './types'

export function createLocalAgentCatalog(): AgentCatalog {
  return {
    list: async () => {
      const agentsDir = getAgentsDir()
      await ensureDirectory(agentsDir)
      return listDirectories(agentsDir)
    },
    exists: (slug) => directoryExists(getAgentDir(slug)),
    mint: () => generateAgentId(),
    resolve: (input) => resolveAgentId(input),
    remove: (slug) => removeDirectory(getAgentDir(slug)),
  }
}

export const agentCatalog: AgentCatalog = createLocalAgentCatalog()
