import { AsyncLocalStorage } from 'node:async_hooks'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'

/**
 * How a session came to exist. Every path that mints a Better Auth session on
 * this deployment resolves to exactly one of these, so the audit trail can
 * answer "where did this credential come from" without a read across the trust
 * boundary into platform logs.
 *
 * `unknown` is deliberate, not a fallback bug: a session created outside any
 * known path is more interesting than one we can name, and silently dropping it
 * would leave a hole exactly where an unexpected issuer would show up.
 */
export const SESSION_CREATION_METHODS = [
  'password',
  'oidc',
  'token-exchange',
  'impersonation',
  'unknown',
] as const

export type SessionCreationMethod = (typeof SESSION_CREATION_METHODS)[number]

export interface SessionAuditContext {
  method: SessionCreationMethod
  /** Present only where the credential itself named an org (the RFC 7523 grant). */
  orgId?: string
}

/**
 * Better Auth endpoint paths that end in a session, keyed by the registered
 * path template (`dispatchAuthEndpoint` puts `endpoint.path` on the context, so
 * these are the literal templates, not concrete request URLs).
 *
 * Matched exactly. A path that stops minting sessions upstream simply stops
 * appearing here; a new one that starts is recorded as `unknown` until it is
 * added, which is the safe direction to be wrong in.
 */
const METHOD_BY_ENDPOINT_PATH: Record<string, SessionCreationMethod> = {
  '/sign-in/email': 'password',
  // Auto sign-in on registration mints a session on the sign-up endpoint.
  '/sign-up/email': 'password',
  '/callback/:id': 'oidc',
  '/oauth2/callback/:providerId': 'oidc',
  '/admin/impersonate-user': 'impersonation',
}

/**
 * Sessions minted outside a Better Auth endpoint carry no endpoint context, so
 * the caller tags them here instead. Async-local rather than a module flag: two
 * concurrent exchanges must not be able to read each other's tag.
 */
const auditContextStore = new AsyncLocalStorage<SessionAuditContext>()

/**
 * Run `fn` with an explicit attribution for any session it creates. Must wrap
 * the `createSession` call itself — the database hook that reads it runs
 * synchronously within that call.
 */
export function withSessionAuditContext<T>(context: SessionAuditContext, fn: () => T): T {
  return auditContextStore.run(context, fn)
}

/**
 * An explicit tag always wins: a caller that knows how the session was minted
 * knows better than an endpoint path, and a tagged call reaching this from
 * inside an endpoint context is still that caller's session.
 */
export function resolveSessionAuditContext(endpointPath?: string | null): SessionAuditContext {
  const tagged = auditContextStore.getStore()
  if (tagged) return tagged
  const method = endpointPath ? METHOD_BY_ENDPOINT_PATH[endpointPath] : undefined
  return { method: method ?? 'unknown' }
}

/**
 * Record one `session:created` audit row.
 *
 * Details carry the attribution and nothing else — no token, assertion, jti,
 * email, name, IP, or user-agent. The user is identified by `userId` (a foreign
 * key the audit UI resolves), and the session row itself already holds the
 * user-agent for the sessions list, so copying attacker-controlled text into a
 * durable trail would add surface without adding information.
 */
export async function auditSessionCreated(
  session: { id: string; userId: string },
  endpointPath?: string | null,
): Promise<void> {
  const { method, orgId } = resolveSessionAuditContext(endpointPath)
  await logAuditEvent({
    userId: session.userId,
    object: 'session',
    objectId: session.id,
    action: 'created',
    details: { method, ...(orgId ? { orgId } : {}) },
  })
}
