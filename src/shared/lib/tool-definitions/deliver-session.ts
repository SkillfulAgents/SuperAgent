export interface DeliverSessionInput {
  session_id?: string
  agent_slug?: string
  description?: string
}

function parseInput(input: unknown): DeliverSessionInput {
  return typeof input === 'object' && input !== null ? (input as DeliverSessionInput) : {}
}

export function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

// Return null so the collapsed row doesn't render a slug-based summary in the
// middle — the CollapsedContent pill already shows the agent + session name,
// and we want to give it the room.
function getSummary(_input: unknown): string | null {
  return null
}

export const deliverSessionDef = {
  displayName: 'Deliver Session',
  iconName: 'ArrowRight',
  parseInput,
  getSummary,
} as const
