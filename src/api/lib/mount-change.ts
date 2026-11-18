import { agentRegistry } from '@shared/lib/agent-actor/registry'
import { agentsWithVolume } from '@shared/lib/services/mount-service'

/** A running container keeps the drives it started with until it restarts. */
export async function afterMountChange(agentSlug: string, restart?: boolean): Promise<void> {
  await agentRegistry.get(agentSlug).container.invalidate({ restart })
}

/**
 * A drive changed under every agent that has it: each running one is marked
 * stale for the person to restart, and a stopped one picks the change up at
 * its next start. One agent that can't be marked doesn't undo the change.
 */
export async function afterVolumeChange(volumeId: string): Promise<void> {
  const results = await Promise.allSettled((await agentsWithVolume(volumeId)).map(slug => afterMountChange(slug)))
  for (const result of results) {
    if (result.status === 'rejected') console.error('[volumes] Could not mark an agent with a changed drive for a restart:', result.reason)
  }
}
