// Shared types and utilities for fetching agent status
// Used by both the system tray and the application menu

export interface ApiAgent {
  slug: string
  name: string
  status: 'running' | 'stopped'
}

export interface ApiSession {
  id: string
  isActive: boolean
}

export type ActivityStatus = 'working' | 'idle' | 'sleeping'

export interface AgentInfo {
  slug: string
  name: string
  activityStatus: ActivityStatus
}

/**
 * Apply saved agent ordering (matches renderer's applyAgentOrder logic).
 * Agents in savedOrder keep their saved position; unknown agents go first.
 */
function applyAgentOrder(agents: AgentInfo[], savedOrder: string[] | undefined): AgentInfo[] {
  if (!savedOrder || savedOrder.length === 0) return agents

  const positionMap = new Map(savedOrder.map((slug, i) => [slug, i]))

  const ordered: AgentInfo[] = []
  const newAgents: AgentInfo[] = []

  for (const agent of agents) {
    if (positionMap.has(agent.slug)) {
      ordered.push(agent)
    } else {
      newAgents.push(agent)
    }
  }

  ordered.sort((a, b) => positionMap.get(a.slug)! - positionMap.get(b.slug)!)

  return [...newAgents, ...ordered]
}

/**
 * Fetch agents with their activity status from the API,
 * sorted by the user's saved agent order.
 */
export async function fetchAgentsWithStatus(apiPort: number): Promise<AgentInfo[]> {
  try {
    // Fetch agents and user settings in parallel
    const [agentsRes, settingsRes] = await Promise.all([
      fetch(`http://localhost:${apiPort}/api/agents`),
      fetch(`http://localhost:${apiPort}/api/user-settings`).catch(() => null),
    ])
    if (!agentsRes.ok) return []
    const agents: ApiAgent[] = await agentsRes.json()

    const agentOrder: string[] | undefined =
      settingsRes?.ok ? (await settingsRes.json())?.agentOrder : undefined

    // For each running agent, check if it has active sessions
    const agentsWithStatus: AgentInfo[] = await Promise.all(
      agents.map(async (agent) => {
        let hasActiveSessions = false

        if (agent.status === 'running') {
          try {
            const sessionsRes = await fetch(
              `http://localhost:${apiPort}/api/agents/${agent.slug}/sessions`
            )
            if (sessionsRes.ok) {
              const sessions: ApiSession[] = await sessionsRes.json()
              hasActiveSessions = sessions.some(s => s.isActive)
            }
          } catch {
            // Ignore session fetch errors
          }
        }

        // Derive activity status (matches getAgentActivityStatus logic)
        let activityStatus: ActivityStatus
        if (agent.status === 'stopped') {
          activityStatus = 'sleeping'
        } else if (hasActiveSessions) {
          activityStatus = 'working'
        } else {
          activityStatus = 'idle'
        }

        return {
          slug: agent.slug,
          name: agent.name,
          activityStatus,
        }
      })
    )

    return applyAgentOrder(agentsWithStatus, agentOrder)
  } catch (error) {
    console.error('Failed to fetch agents:', error)
    return []
  }
}
