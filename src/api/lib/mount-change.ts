import { containerHost } from '@shared/lib/agent-actor'
import { agentRegistry } from '@shared/lib/agent-actor/registry'
import { agentsWithVolume, getMounts } from '@shared/lib/services/mount-service'
import { globalFeed } from '@shared/lib/notifications/global-feed'

async function invalidate(agentSlug: string, restart?: boolean): Promise<void> {
  if (await agentRegistry.get(agentSlug).container.invalidate({ restart }) === 'marked-stale') {
    globalFeed.publish({ type: 'agent_updated', agentSlug })
  }
}

/** A running container keeps the drives it started with until it restarts. Every window shows the change and the prompt at once. */
export async function afterMountChange(agentSlug: string, restart?: boolean): Promise<void> {
  globalFeed.publish({ type: 'volume_attention_changed' })
  await invalidate(agentSlug, restart)
}

/** One agent that can't be marked doesn't undo the change. */
async function markStale(slugs: string[]): Promise<void> {
  const results = await Promise.allSettled(slugs.map(slug => invalidate(slug)))
  for (const result of results) {
    if (result.status === 'rejected') console.error('[volumes] Could not mark an agent with a changed drive for a restart:', result.reason)
  }
}

/** A drive's source changed under every running agent that has it, a start past its drive read included. A stopped one picks it up at its next start. */
export async function afterVolumeChange(volumeId: string): Promise<void> {
  globalFeed.publish({ type: 'volume_attention_changed' })
  try {
    const holding = new Set(containerHost.getAgentIdsHoldingDrives())
    await markStale((await agentsWithVolume(volumeId)).filter(slug => holding.has(slug)))
  } catch (error) {
    console.error('[volumes] Could not find the agents a drive change reached:', error)
  }
}

/** Each agent's drives, or null for one that could not be read, which is then left out rather than the rest. */
async function heldMounts(options?: { orStarting?: boolean }): Promise<Map<string, string | null>> {
  const slugs = containerHost.getAgentIdsHoldingDrives(options)
  const reads = await Promise.allSettled(slugs.map(async slug => JSON.stringify(await getMounts(slug))))
  return new Map(reads.map((read, i) => {
    if (read.status === 'fulfilled') return [slugs[i], read.value]
    console.error(`[volumes] Could not read ${slugs[i]}'s drives:`, read.reason)
    return [slugs[i], null]
  }))
}

/**
 * Runs a change to drive settings, then marks stale each running agent whose
 * drives it changed: a rename, global on or off, a drive gone. Saving the same
 * values, or a change an agent's own attachment overrides, marks none. The
 * first read includes starts not yet at their drive read, so one that reads
 * during the change is compared too. Only a start that begins during the change is marked unread.
 */
export async function changeDrives<T>(change: () => Promise<T>): Promise<T> {
  const before = await heldMounts({ orStarting: true })
  const result = await change()
  // Every open window refreshes its drive rows and drive list, whichever agent it shows.
  globalFeed.publish({ type: 'volume_attention_changed' })
  const after = await heldMounts()
  await markStale([...after].filter(([slug, mounts]) => mounts !== null && before.get(slug) !== null && before.get(slug) !== mounts).map(([slug]) => slug))
  return result
}
