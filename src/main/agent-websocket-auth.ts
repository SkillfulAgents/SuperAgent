import type { IncomingMessage } from 'http'
import { and, eq } from 'drizzle-orm'

import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { type AgentRole, ROLE_HIERARCHY } from '@shared/lib/types/agent'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Authenticate an upgrade request, which bypasses Hono's HTTP middleware. */
export async function authenticateAgentWebSocket(
  request: IncomingMessage,
  agentSlug: string,
  minRole: AgentRole,
): Promise<boolean> {
  if (!isAuthMode()) {
    // The Electron API binds beyond loopback so containers can reach it. Do not
    // let another machine on that interface upgrade into an agent endpoint.
    if (process.type === 'browser') {
      const addr = request.socket?.remoteAddress
      if (!addr || !LOCALHOST_ADDRS.has(addr)) return false
    }
    return true
  }

  try {
    // Lazy import avoids pulling Better Auth's ESM graph into desktop startup.
    const { getAuth } = await import('@shared/lib/auth/index')
    const auth = getAuth()
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value) headers.set(key, Array.isArray(value) ? value[0] : value)
    }

    const session = await auth.api.getSession({ headers })
    if (!session?.user) return false

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
