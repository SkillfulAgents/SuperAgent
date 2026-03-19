import type { ApiAgent } from '@renderer/hooks/use-agents'

/**
 * Apply a saved agent ordering to the agent list.
 * - Agents in savedOrder are sorted by their position in that array.
 * - New agents (not in savedOrder) are placed at the top, sorted by createdAt desc.
 * - Slugs in savedOrder that don't match any agent are silently ignored.
 */
export function applyAgentOrder(
  agents: ApiAgent[],
  savedOrder: string[] | undefined
): ApiAgent[] {
  if (!savedOrder || savedOrder.length === 0) {
    return agents
  }

  const positionMap = new Map(savedOrder.map((slug, i) => [slug, i]))

  const ordered: ApiAgent[] = []
  const newAgents: ApiAgent[] = []

  for (const agent of agents) {
    if (positionMap.has(agent.slug)) {
      ordered.push(agent)
    } else {
      newAgents.push(agent)
    }
  }

  ordered.sort((a, b) => positionMap.get(a.slug)! - positionMap.get(b.slug)!)

  newAgents.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )

  return [...newAgents, ...ordered]
}
