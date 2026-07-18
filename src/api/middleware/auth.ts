import type { Context, Next, MiddlewareHandler } from 'hono'
import { and, eq } from 'drizzle-orm'
import { isAuthMode } from '@shared/lib/auth/mode'
import { runWithOptionalUser, runWithRequestUser } from '@shared/lib/platform-attribution'
import { db } from '@shared/lib/db'
import { agentAcl, connectedAccounts, remoteMcpServers, notifications } from '@shared/lib/db/schema'
import { getAgentOwnerUserId } from '@shared/lib/services/agent-owner'
import { validateProxyToken } from '@shared/lib/proxy/token-store'
import { resolveAgentId } from '@shared/lib/utils/file-storage'

// Lazy import to avoid pulling in better-auth ESM at import time
let _getAuth: (() => ReturnType<typeof import('@shared/lib/auth/index').getAuth>) | null = null
async function getAuthLazy() {
  if (!_getAuth) {
    const mod = await import('@shared/lib/auth/index')
    _getAuth = mod.getAuth
  }
  return _getAuth()
}

// Re-export from shared types so existing consumers (webhook-triggers.ts etc.) keep working
export { type AgentRole, ROLE_HIERARCHY, hasMinRole } from '@shared/lib/types/agent'
import { type AgentRole, hasMinRole } from '@shared/lib/types/agent'

const AUTHORIZED_AGENT_ROLE_CONTEXT_KEY = 'authorizedAgentRole'

function setAuthorizedAgentRole(c: Context, role: AgentRole): void {
  c.set(AUTHORIZED_AGENT_ROLE_CONTEXT_KEY as never, role as never)
}

/**
 * Read the role established by AgentRead/AgentUser/AgentAdmin or
 * EntityAgentRole. Returns null when no role-aware middleware ran so callers
 * can default to the least-privileged response shape.
 */
export function getAuthorizedAgentRole(c: Context): AgentRole | null {
  const role = c.get(AUTHORIZED_AGENT_ROLE_CONTEXT_KEY as never) as AgentRole | undefined
  return role ?? null
}

/**
 * Authenticated — verifies user session and attaches user to context.
 * No-op when AUTH_MODE is disabled.
 */
export function Authenticated(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) {
      return runWithRequestUser('local', () => next())
    }

    const auth = await getAuthLazy()
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    c.set('user' as never, session.user as never)
    return runWithRequestUser(session.user.id, () => next())
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

/**
 * ResolveAgent — resolve the `:id` route param (which may be a decorative
 * display slug, a bare id, or a legacy compound folder name) to the canonical
 * agent id, stash it on the context as `agentId`, and 404 if no such agent
 * exists.
 *
 * Runs in BOTH auth and non-auth modes (the URL form is independent of auth)
 * and MUST run before any AgentRead/AgentUser/AgentAdmin check, since the ACL
 * tables are keyed on the canonical id. Subsumes the old agent-existence guard.
 */
export function ResolveAgent(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const id = await resolveAgentId(c.req.param('id') ?? '')
    if (!id) return c.json({ error: 'Agent not found' }, 404)
    c.set('agentId' as never, id as never)
    return next()
  }
}

/**
 * Read the canonical agent id resolved by {@link ResolveAgent}. Route handlers
 * under a `:id` path should use this instead of `c.req.param('id')`, which may
 * be a decorative display slug. Throws if ResolveAgent() did not run.
 */
export function getAgentId(c: Context): string {
  const id = c.get('agentId' as never) as string | undefined
  if (!id) throw new Error('agentId not resolved — ResolveAgent() middleware missing?')
  return id
}

// Resolved id if ResolveAgent() ran, else the raw param (preserves behavior for
// any ACL middleware mounted without ResolveAgent in front).
function resolvedAgentSlug(c: Context): string {
  return (c.get('agentId' as never) as string | undefined) ?? c.req.param('id')!
}


/**
 * AgentRead — user has any role on the agent (viewer+).
 * Expects `:id` route param for the agent slug.
 */
export function AgentRead(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) {
      setAuthorizedAgentRole(c, 'owner')
      return next()
    }

    const user = getUser(c)
    if (isAdmin(user)) {
      setAuthorizedAgentRole(c, 'owner')
      return next()
    }
    const agentSlug = resolvedAgentSlug(c)
    const role = await getUserAgentRole(user.id, agentSlug)
    if (!role || !hasMinRole(role, 'viewer')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    setAuthorizedAgentRole(c, role)
    return next()
  }
}

/**
 * AgentUser — user has 'user' or 'owner' role on the agent.
 * Expects `:id` route param for the agent slug.
 */
export function AgentUser(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) {
      setAuthorizedAgentRole(c, 'owner')
      return next()
    }

    const user = getUser(c)
    if (isAdmin(user)) {
      setAuthorizedAgentRole(c, 'owner')
      return next()
    }
    const agentSlug = resolvedAgentSlug(c)
    const role = await getUserAgentRole(user.id, agentSlug)
    if (!role || !hasMinRole(role, 'user')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    setAuthorizedAgentRole(c, role)
    return next()
  }
}

/**
 * AgentAdmin — user has 'owner' role on the agent.
 * Expects `:id` route param for the agent slug.
 */
export function AgentAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) {
      setAuthorizedAgentRole(c, 'owner')
      return next()
    }

    const user = getUser(c)
    if (isAdmin(user)) {
      setAuthorizedAgentRole(c, 'owner')
      return next()
    }
    const agentSlug = resolvedAgentSlug(c)
    const role = await getUserAgentRole(user.id, agentSlug)
    if (!role || !hasMinRole(role, 'owner')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    setAuthorizedAgentRole(c, role)
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
// Entity-based agent role middleware
// ---------------------------------------------------------------------------

/**
 * EntityAgentRole — generic factory for middleware that loads an entity (e.g.
 * a scheduled task or webhook trigger) by route param, stashes it on the Hono
 * context, then verifies the user holds at least `minRole` on the entity's agent.
 *
 * Usage:
 *   const TaskRole = EntityAgentRole({
 *     paramName: 'taskId',
 *     lookupFn: getScheduledTask,
 *     contextKey: 'scheduledTask',
 *     entityName: 'Scheduled task',
 *   })
 *   router.get('/:taskId', TaskRole('viewer'), handler)
 */
export function EntityAgentRole<T extends { agentSlug: string }>(opts: {
  paramName: string
  lookupFn: (id: string) => Promise<T | null | undefined>
  contextKey: string
  entityName: string
}): (minRole: AgentRole) => MiddlewareHandler {
  return (minRole: AgentRole): MiddlewareHandler => {
    return async (c: Context, next: Next) => {
      const id = c.req.param(opts.paramName)!
      const entity = await opts.lookupFn(id)
      if (!entity) {
        return c.json({ error: `${opts.entityName} not found` }, 404)
      }
      c.set(opts.contextKey as never, entity as never)

      if (!isAuthMode()) {
        setAuthorizedAgentRole(c, 'owner')
        return next()
      }

      const user = getUser(c)
      const role = await getUserAgentRole(user.id, entity.agentSlug)
      if (!role || !hasMinRole(role, minRole)) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      setAuthorizedAgentRole(c, role)
      return next()
    }
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
    const accountId = c.req.param('id')!
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
    const mcpId = c.req.param('id')!
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
 * OwnsAccountByParam — like OwnsAccount but reads the account ID from a named
 * route parameter (e.g. `:accountId`) instead of the default `:id`.
 * Falls through in non-auth mode. Admins always pass.
 */
export function OwnsAccountByParam(param: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (isAdmin(user)) return next()

    const accountId = c.req.param(param)
    if (!accountId) return c.json({ error: 'Forbidden' }, 403)
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
 * OwnsMcpByParam — like UsersMcpServer but reads the MCP ID from a named
 * route parameter (e.g. `:mcpId`) instead of the default `:id`.
 * Falls through in non-auth mode. Admins always pass.
 */
export function OwnsMcpByParam(param: string): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isAuthMode()) return next()

    const user = getUser(c)
    if (isAdmin(user)) return next()

    const mcpId = c.req.param(param)
    if (!mcpId) return c.json({ error: 'Forbidden' }, 403)
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

    const notificationId = c.req.param('id')!
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
 * Gate for container→host routes. Validates the agent proxy token, stashes `agentSlug` (SUP-216),
 * and runs under the agent owner's attribution scope so billed proxy calls (`/v1/browserbase`,
 * `/v1/exa`) carry `token::memberId`. Single-user installs have no ACL row → null scope.
 */
export function IsAgent(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '')
    const agentSlug = token ? await validateProxyToken(token) : null
    if (!token || !agentSlug) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    c.set('agentSlug' as never, agentSlug as never)
    return runWithOptionalUser(getAgentOwnerUserId(agentSlug), () => next())
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
