import { and, eq } from 'drizzle-orm'

import { isAuthMode } from '@shared/lib/auth/mode'
import { getTrustedOrigins } from '@shared/lib/auth/trusted-origins'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { type AgentRole, ROLE_HIERARCHY } from '@shared/lib/types/agent'
import type { AgentSocketRequest } from './agent-socket'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether a socket may open from the page its browser names. A WebSocket is
 * not bound by CORS, so without this a page on another site, or on another
 * subdomain that shares this one's cookies, could read the stream as the
 * signed-in user. Allowed: no page (not a browser), the desktop renderer (a
 * `file://` page, which a browser sends as `null`, or a loopback dev server),
 * this server's own pages, and its trusted origins. Same rule as the cloud
 * proxy's Origin check (`api/routes/cloud-proxy.ts`), plus this server's pages.
 */
export function socketOriginAllowed(request: AgentSocketRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin || origin === 'null') return true
  let page: URL
  try {
    page = new URL(origin)
  } catch {
    return false
  }
  if (page.protocol === 'file:' || LOOPBACK_HOSTNAMES.has(page.hostname)) return true
  if (page.host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))) return true
  return getTrustedOrigins().some((trusted) => {
    try {
      return new URL(trusted).host === page.host
    } catch {
      return false
    }
  })
}

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
    const auth = getAuth()
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

/** The user an upgrade request is signed in as: undefined outside auth mode, null when it may not connect. */
export async function authenticateUserWebSocket(request: AgentSocketRequest): Promise<{ id: string } | undefined | null> {
  if (!isAuthMode()) return isLocalPeer(request) ? undefined : null
  try {
    const { getAuth } = await import('@shared/lib/auth/index')
    const session = await getAuth().api.getSession({ headers: request.headers })
    return session?.user ? { id: session.user.id } : null
  } catch (error) {
    console.error('[WebSocketAuth] Auth check failed:', error)
    return null
  }
}

// The Electron API binds beyond loopback so containers can reach it. Do not
// let another machine on that interface upgrade into an app endpoint.
function isLocalPeer(request: AgentSocketRequest): boolean {
  if (process.type !== 'browser') return true
  const addr = request.remoteAddress
  return !!addr && LOCALHOST_ADDRS.has(addr)
}
