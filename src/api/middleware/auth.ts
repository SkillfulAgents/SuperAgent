import type { Context, Next, MiddlewareHandler } from 'hono'
import { and, eq } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'
import { db } from '@shared/lib/db'
import { agentAcl, connectedAccounts, remoteMcpServers, notifications } from '@shared/lib/db/schema'
import { validateProxyToken } from '@shared/lib/proxy/token-store'

// Lazy import to avoid pulling in better-auth ESM at import time
let _getAuth: (() => ReturnType<typeof import('@shared/lib/auth/index').getAuth>) | null = null
async function getAuthLazy() {
  if (!_getAuth) {
    const mod = await import('@shared/lib/auth/index')
    _getAuth = mod.getAuth
  }
  return _getAuth()
}

type AgentRole = 'owner' | 'user' | 'viewer'

/**
 * Authenticated — verifies user session and attaches user to context.
 * No-op when AUTH_MODE is disabled.
 */
export function Authenticated(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const auth = await getAuthLazy()
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    c.set('user' as never, session.user as never)
    return next()
  }
}

// ---------------------------------------------------------------------------
// Agent ACL helpers
// ---------------------------------------------------------------------------

async function getUserAgentRole(userId: string, agentSlug: string): Promise<AgentRole | null> {
  const row = await db
    .select({ role: agentAcl.role })
    .from(agentAcl)
    .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, agentSlug)))
    .limit(1)
  return (row[0]?.role as AgentRole) ?? null
}

function getUser(c: Context): { id: string; role?: string } {
  const user = c.get('user' as never) as { id: string; role?: string } | undefined
  if (!user) throw new Error('User not found in context — Authenticated() middleware missing?')
  return user
}

function isAdmin(user: { role?: string }): boolean {
  return user.role === 'admin'
}

const ROLE_HIERARCHY: Record<AgentRole, number> = { viewer: 0, user: 1, owner: 2 }

function hasMinRole(actual: AgentRole | null, required: AgentRole): boolean {
  if (!actual) return false
  return ROLE_HIERARCHY[actual] >= ROLE_HIERARCHY[required]
}

/**
 * AgentRead — user has any role on the agent (viewer+).
 * Expects `:id` route param for the agent slug.
 */
export function AgentRead(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (isAdmin(user)) return next()
    const agentSlug = c.req.param('id')
    const role = await getUserAgentRole(user.id, agentSlug)
    if (!hasMinRole(role, 'viewer')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  }
}

/**
 * AgentUser — user has 'user' or 'owner' role on the agent.
 * Expects `:id` route param for the agent slug.
 */
export function AgentUser(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (isAdmin(user)) return next()
    const agentSlug = c.req.param('id')
    const role = await getUserAgentRole(user.id, agentSlug)
    if (!hasMinRole(role, 'user')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  }
}

/**
 * AgentAdmin — user has 'owner' role on the agent.
 * Expects `:id` route param for the agent slug.
 */
export function AgentAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (isAdmin(user)) return next()
    const agentSlug = c.req.param('id')
    const role = await getUserAgentRole(user.id, agentSlug)
    if (!hasMinRole(role, 'owner')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  }
}

/**
 * IsAdmin — user has the 'admin' role (Better Auth admin plugin).
 */
export function IsAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (!isAdmin(user)) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  }
}

// ---------------------------------------------------------------------------
// Ownership middleware
// ---------------------------------------------------------------------------

/**
 * OwnsAccount — user owns the connected account referenced by `:id` param.
 * Used in Or(OwnsAccount(), IsAdmin()) patterns.
 */
export function OwnsAccount(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    const accountId = c.req.param('id')
    const row = await db
      .select({ userId: connectedAccounts.userId })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, accountId))
      .limit(1)

    if (!row[0] || row[0].userId !== user.id) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  }
}

/**
 * UsersMcpServer — user owns the remote MCP server referenced by `:id` param.
 * Used in Or(UsersMcpServer(), IsAdmin()) patterns.
 */
export function UsersMcpServer(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    const mcpId = c.req.param('id')
    const row = await db
      .select({ userId: remoteMcpServers.userId })
      .from(remoteMcpServers)
      .where(eq(remoteMcpServers.id, mcpId))
      .limit(1)

    if (!row[0] || row[0].userId !== user.id) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return next()
  }
}

/**
 * HasNotificationAccess — user has access to the notification's agent.
 * Admins can access any notification. Regular users need an agentAcl entry
 * for the notification's agentSlug. Expects `:id` route param.
 */
export function HasNotificationAccess(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (isAdmin(user)) return next()

    const notificationId = c.req.param('id')
    const row = await db
      .select({ agentSlug: notifications.agentSlug })
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .limit(1)

    if (!row[0]) return c.json({ error: 'Not found' }, 404)

    const role = await getUserAgentRole(user.id, row[0].agentSlug)
    if (!role) return c.json({ error: 'Forbidden' }, 403)

    return next()
  }
}

// ---------------------------------------------------------------------------
// Agent (container) token auth
// ---------------------------------------------------------------------------

/**
 * IsAgent — validates synthetic bearer token from a container.
 * Works in both auth and non-auth modes (containers always use proxy tokens).
 */
export function IsAgent(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token || !(await validateProxyToken(token))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  }
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Or — pass if ANY of the given middleware passes.
 * Tries each middleware in order. If one passes (calls next), the request proceeds.
 * If all fail, returns a generic 403 Forbidden response.
 * In non-auth mode, passes through immediately.
 */
export function Or(...middlewares: MiddlewareHandler[]): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    for (const mw of middlewares) {
      let passed = false
      // Run middleware with a fake next that marks success
      await mw(c, async () => { passed = true })
      if (passed) return next()
    }

    // All failed — return 403
    return c.json({ error: 'Forbidden' }, 403)
  }
}
