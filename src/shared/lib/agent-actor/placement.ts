/**
 * Where an agent lives: its container and its workspace files on this
 * machine (`local`), or in a Modal sandbox with the workspace on a Modal
 * volume (`modal`). The registry reads it to decide which actor to build,
 * and the container client factory reads it to decide which runtime client
 * backs the agent's `ContainerRuntime`.
 *
 * The placement is a host-side document beside the agent's workspace
 * directory, never inside it: the workspace of a remote agent is not on this
 * machine, and the document is what says so. The documents are loaded once
 * at boot, before the first handle is built, so that `agentRegistry.get`
 * stays what it promises to be: no I/O, never fails. An agent with no
 * document is local, which is every agent that predates this document; a
 * placement written while the process runs is cached as it is written.
 */
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { getAgentsDataDir } from '@shared/lib/config/data-dir'
import { writeJsonFileAtomic } from '@shared/lib/utils/file-storage'

export const agentPlacementSchema = z.discriminatedUnion('runtime', [
  z.object({ runtime: z.literal('local') }),
  z.object({
    runtime: z.literal('modal'),
    /** The Modal volume that is this agent's `/workspace`. */
    volumeName: z.string().min(1),
  }),
])

export type AgentPlacement = z.infer<typeof agentPlacementSchema>
export type ModalAgentPlacement = Extract<AgentPlacement, { runtime: 'modal' }>

const LOCAL_PLACEMENT: AgentPlacement = { runtime: 'local' }
const PLACEMENT_FILE = 'placement.json'

const cache = new Map<string, AgentPlacement>()

function placementPath(slug: string): string {
  return path.join(getAgentsDataDir(), slug, PLACEMENT_FILE)
}

/** The agent's placement as loaded or written in this process; local when nothing was. Synchronous, no I/O. */
export function readAgentPlacement(slug: string): AgentPlacement {
  return cache.get(slug) ?? LOCAL_PLACEMENT
}

/**
 * Read one agent's placement document into the cache. An absent document is
 * local. A document that does not parse throws: guessing local for an agent
 * whose files are elsewhere would write to the wrong place.
 */
export async function loadAgentPlacement(slug: string): Promise<AgentPlacement> {
  let raw: string
  try {
    raw = await fs.promises.readFile(placementPath(slug), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    cache.set(slug, LOCAL_PLACEMENT)
    return LOCAL_PLACEMENT
  }
  let placement: AgentPlacement
  try {
    placement = agentPlacementSchema.parse(JSON.parse(raw))
  } catch (error) {
    throw new Error(`Agent ${slug} has an unreadable placement document: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  cache.set(slug, placement)
  return placement
}

/** Load every agent's placement at boot. Returns the agents placed on Modal. */
export async function loadAgentPlacements(slugs: readonly string[]): Promise<string[]> {
  const placements = await Promise.all(slugs.map(async (slug) => [slug, await loadAgentPlacement(slug)] as const))
  return placements.filter(([, placement]) => placement.runtime === 'modal').map(([slug]) => slug)
}

export async function writeAgentPlacement(slug: string, placement: AgentPlacement): Promise<void> {
  const validated = agentPlacementSchema.parse(placement)
  await fs.promises.mkdir(path.dirname(placementPath(slug)), { recursive: true })
  await writeJsonFileAtomic(placementPath(slug), validated)
  cache.set(slug, validated)
}

/** Drop the cached placement. For an agent that no longer exists. */
export function forgetAgentPlacement(slug: string): void {
  cache.delete(slug)
}

/** The Modal volume name for an agent: the id, in the character set Modal accepts for object names. */
export function modalVolumeNameFor(slug: string): string {
  const safe = slug.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'agent'
  return `superagent-${safe}`.slice(0, 63)
}
