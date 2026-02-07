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
 * Fetch agents with their activity status from the API
 */
export async function fetchAgentsWithStatus(apiPort: number): Promise<AgentInfo[]> {
  try {
    // Fetch all agents
    const agentsRes = await fetch(`http://localhost:${apiPort}/api/agents`)
    if (!agentsRes.ok) return []
    const agents: ApiAgent[] = await agentsRes.json()

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

    return agentsWithStatus
  } catch (error) {
    console.error('Failed to fetch agents:', error)
    return []
  }
}
