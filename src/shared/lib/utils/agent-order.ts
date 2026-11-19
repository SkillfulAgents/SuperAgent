/**
 * Apply a saved agent ordering to an agent list. One definition for the
 * renderer (sidebar, Home) and Electron main (tray, Agents menu), so the two
 * cannot list the same agents in different orders.
 *
 * - Agents in savedOrder are sorted by their position in that array.
 * - New agents (not in savedOrder) are placed at the top, sorted by createdAt desc.
 * - Slugs in savedOrder that don't match any agent are silently ignored.
 */
export function applyAgentOrder<T extends { slug: string; createdAt: Date | string }>(
  agents: T[],
  savedOrder: string[] | undefined
): T[] {
  if (!savedOrder || savedOrder.length === 0) {
    return agents
  }

  const positionMap = new Map(savedOrder.map((slug, i) => [slug, i]))

  const ordered: T[] = []
  const newAgents: T[] = []

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
