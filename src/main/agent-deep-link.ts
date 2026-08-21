export interface AgentDeepLink {
  agentSlug: string
  sessionId: string | null
}

/**
 * Pure parser for the agent deep-link family.
 * Position-anchored: only `/sessions/<id>` immediately after the slug counts.
 * Malformed slug encoding → null (no navigation). Malformed session encoding →
 * degrade to slug-only. Extra/unknown segments ignored (legacy lenience).
 */
export function parseAgentDeepLink(url: string, scheme: string): AgentDeepLink | null {
  const prefix = `${scheme}://agent/`
  if (!url.startsWith(prefix)) return null
  const segments = url.slice(prefix.length).split('/')
  let agentSlug: string
  try {
    agentSlug = decodeURIComponent(segments[0])
  } catch {
    return null
  }
  if (!agentSlug) return null
  let sessionId: string | null = null
  if (segments[1] === 'sessions' && segments[2]) {
    try {
      sessionId = decodeURIComponent(segments[2])
    } catch {
      sessionId = null
    }
  }
  return { agentSlug, sessionId }
}
