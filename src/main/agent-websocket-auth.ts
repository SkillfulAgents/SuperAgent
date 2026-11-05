import { and, eq } from 'drizzle-orm'

import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { type AgentRole, ROLE_HIERARCHY } from '@shared/lib/types/agent'
import type { AgentSocketRequest } from './agent-socket'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/** Authenticate an upgrade request, which bypasses Hono's HTTP middleware. */
export async function authenticateAgentWebSocket(
  request: AgentSocketRequest,
  agentSlug: string,
  minRole: AgentRole,
): Promise<boolean> {
  if (!isAuthMode()) return isLocalPeer(request)

  try {
    // Lazy import avoids pulling Better Auth's ESM graph into desktop startup.
    const { getAuth } = await import('@shared/lib/auth/index')
    const auth = await getAuth()
    const { headers } = request
    const session = await auth.api.getSession({ headers })
    if (!session?.user) {
      // The meeting bot's page watches its own agent's browser stream; it may not steer it.
      const { authenticateMeetingParticipant } = await import('@shared/lib/meeting-integrations/participant-credential')
      const participant = await authenticateMeetingParticipant(headers.get('cookie'))
      return !!participant && participant.agentSlug === agentSlug && minRole === 'viewer'
    }

    const [row] = await db
      .select({ role: agentAcl.role })
      .from(agentAcl)
      .where(and(eq(agentAcl.userId, session.user.id), eq(agentAcl.agentSlug, agentSlug)))
      .limit(1)

    if (!row) return false
    const userRole = row.role as AgentRole
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole]
  } catch (error) {
    console.error('[WebSocketAuth] Auth check failed:', error)
    return false
  }
}

// The Electron API binds beyond loopback so containers can reach it. Do not
// let another machine on that interface upgrade into an app endpoint.
function isLocalPeer(request: AgentSocketRequest): boolean {
  if (process.type !== 'browser') return true
  const addr = request.remoteAddress
  return !!addr && LOCALHOST_ADDRS.has(addr)
}
