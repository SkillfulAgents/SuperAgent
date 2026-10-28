/** The search that opens the Team Brain agent's Agent Home. Every other visit to it lands on the Team Brain page. */
export const TEAM_BRAIN_AGENT_HOME_SEARCH = { from: '/team-brain' } as const

/** Whether a page's search is that one, so its links can keep the way back to it. */
export const isTeamBrainAgentHome = (search: { from?: string }) => search.from === TEAM_BRAIN_AGENT_HOME_SEARCH.from

/** That search as a query string. */
export const TEAM_BRAIN_AGENT_HOME_QUERY = `from=${encodeURIComponent(TEAM_BRAIN_AGENT_HOME_SEARCH.from)}`

/** The search for a link to an agent's own page: the Team Brain agent's needs this one, or it lands on the Team Brain page. */
export const agentHomeSearchFor = (agent: { teamBrain?: unknown }) => (agent.teamBrain ? TEAM_BRAIN_AGENT_HOME_SEARCH : undefined)
