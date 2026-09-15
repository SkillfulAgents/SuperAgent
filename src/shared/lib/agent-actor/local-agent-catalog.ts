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
import { ModalVolumeFiles } from '@shared/lib/container/modal/modal-volume'
import { forgetAgentPlacement, readAgentPlacement } from './placement'
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
    remove: async (slug) => {
      // An agent on Modal owns a volume too; it goes with the host directory.
      const placement = readAgentPlacement(slug)
      await removeDirectory(getAgentDir(slug))
      forgetAgentPlacement(slug)
      if (placement.runtime === 'modal') await ModalVolumeFiles.remove(placement.volumeName)
    },
  }
}

export const agentCatalog: AgentCatalog = createLocalAgentCatalog()
