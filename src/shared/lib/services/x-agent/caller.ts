/**
 * Who a cross-agent operation (list / invoke / get-sessions / get-transcript /
 * download-file) acts for, and what that caller is allowed to do.
 *
 * - An agent caller is another agent, over `/api/x-agent/*`: its owners' ACL on
 *   the target, the xAgentPolicies (allow / block / review) and the one-hop
 *   rule apply, and the sessions it starts are named after it.
 * - A user caller is a person acting directly (for the MCP server): their own
 *   `agent_acl` role on the target decides, with no policy review and no
 *   one-hop rule.
 */
import type { XAgentFileTransfer, XAgentPick, XAgentRuntime } from '@shared/lib/proxy/x-agent-review'
import type { SessionMetadata } from '@shared/lib/types/agent'

import { and, eq } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { hasMinRole, type AgentRole } from '@shared/lib/types/agent'
import { agentRegistry } from '@shared/lib/agent-actor'
import {
  evaluate as evaluatePolicy,
  type XAgentDecision,
  type XAgentOperation,
} from '@shared/lib/services/x-agent-policy-service'
import { userHasMinRoleOnAgent } from '@shared/lib/services/agent-acl-role'
import { awaitReview } from '@shared/lib/proxy/review-request'
import { withUserReason } from '@shared/lib/proxy/user-reason'

// ----------------------------------------------------------------------------
// Callers
// ----------------------------------------------------------------------------

export interface AgentXAgentCaller {
  kind: 'agent'
  agentSlug: string
  /**
   * The calling Claude session (the container's `_callerSessionId`): the
   * one-hop rule reads its provenance, and its review card shows there.
   */
  sessionId?: string
}

export interface UserXAgentCaller {
  kind: 'user'
  /** The user's id; `local` in non-auth mode. */
  userId: string
  /** A platform admin passes every agent role check, as in AgentRead/AgentUser. */
  isAdmin: boolean
  /** The name of a session this caller's invoke starts. */
  sessionName: string
  /** What a session this caller's invoke starts is registered with. */
  sessionMetadata: Partial<SessionMetadata>
}

export type XAgentCaller = AgentXAgentCaller | UserXAgentCaller

export function agentXAgentCaller(agentSlug: string, sessionId?: string): AgentXAgentCaller {
  return { kind: 'agent', agentSlug, sessionId }
}

export function userXAgentCaller(user: {
  userId: string
  isAdmin?: boolean
  sessionName?: string
  sessionMetadata?: Partial<SessionMetadata>
}): UserXAgentCaller {
  return {
    kind: 'user',
    userId: user.userId,
    isAdmin: user.isAdmin ?? false,
    // Neutral defaults: the MCP PR sets the session's provenance (its name and
    // origin metadata) when it builds its caller.
    sessionName: user.sessionName ?? 'New session',
    sessionMetadata: user.sessionMetadata ?? {},
  }
}

/** The fields a log line or error report names the caller by. */
export function callerLogFields(caller: XAgentCaller): { callerSlug: string } | { callerUserId: string } {
  return caller.kind === 'agent' ? { callerSlug: caller.agentSlug } : { callerUserId: caller.userId }
}

/**
 * Start a read whose answer is looked at later. The reads a route starts
 * together do not depend on each other, and each is still awaited at the point
 * the route used to make it, so refusals (and a read that fails) are reported
 * in the same order as when they ran one after another. One that is never
 * awaited, because an earlier check refused the request, must not surface as an
 * unhandled rejection.
 */
export function startRead<T>(read: Promise<T>): Promise<T> {
  read.catch(() => {})
  return read
}

// ----------------------------------------------------------------------------
// ACL helpers (auth mode)
// ----------------------------------------------------------------------------

/**
 * Find the owner-user IDs for a given agent. In auth mode, x-agent calls
 * carry the caller agent's owner perspective: the caller can only act on
 * targets the *owner* of the caller agent has access to.
 */
export async function getOwnersOfAgent(agentSlug: string): Promise<string[]> {
  const rows = await db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, agentSlug), eq(agentAcl.role, 'owner')))
  return rows.map((r) => r.userId)
}

/**
 * Check whether the caller agent's owner(s) hold at least `minRole` on `targetSlug`.
 * Returns true in non-auth mode (no ACL checks).
 */
async function callerOwnerHasRoleOnTarget(
  callerSlug: string,
  targetSlug: string,
  minRole: AgentRole,
): Promise<boolean> {
  if (!isAuthMode()) return true
  // One statement: the roles the caller's owners hold on the target. No owner
  // on the caller, or no owner with a row on the target, is no rows.
  const callerOwner = alias(agentAcl, 'caller_owner')
  const roles = await db
    .select({ role: agentAcl.role })
    .from(callerOwner)
    .innerJoin(agentAcl, eq(agentAcl.userId, callerOwner.userId))
    .where(and(
      eq(callerOwner.agentSlug, callerSlug),
      eq(callerOwner.role, 'owner'),
      eq(agentAcl.agentSlug, targetSlug),
    ))
  return roles.some((row) => hasMinRole(row.role as AgentRole, minRole))
}

/**
 * In auth mode, return the set of agent slugs the caller's owner(s) can
 * see (any role). In non-auth mode, returns null (= no filter).
 */
async function visibleAgentSlugs(callerSlug: string): Promise<Set<string> | null> {
  if (!isAuthMode()) return null
  const callerOwners = await getOwnersOfAgent(callerSlug)
  if (callerOwners.length === 0) return new Set()
  const owned = new Set<string>()
  for (const userId of callerOwners) {
    const rows = await db
      .select({ agentSlug: agentAcl.agentSlug })
      .from(agentAcl)
      .where(eq(agentAcl.userId, userId))
    for (const r of rows) owned.add(r.agentSlug)
  }
  return owned
}

/** The agents a user can read (viewer+); null = no filter (non-auth mode or an admin). */
async function userVisibleAgentSlugs(caller: UserXAgentCaller): Promise<Set<string> | null> {
  if (!isAuthMode() || caller.isAdmin) return null
  const rows = await db
    .select({ agentSlug: agentAcl.agentSlug, role: agentAcl.role })
    .from(agentAcl)
    .where(eq(agentAcl.userId, caller.userId))
  return new Set(rows.filter((row) => hasMinRole(row.role as AgentRole, 'viewer')).map((row) => row.agentSlug))
}

// ----------------------------------------------------------------------------
// Policy + review helper
// ----------------------------------------------------------------------------

export type PolicyOutcome = { allowed: boolean; reason?: string; pick?: XAgentPick }

/**
 * Resolve the policy decision and run a review prompt if needed.
 * Returns { allowed: true } on allow, { allowed: false, reason } on block/deny.
 *
 * This helper does NOT persist anything. Persistence of "Allow always" decisions
 * happens in the UI-facing /api/agents/:id/proxy-review/:reviewId/always handler
 * (agents.ts), which writes the policy row before resolving the in-flight review.
 * Plain "Allow once" decisions go through /proxy-review/:reviewId and are not
 * remembered. 'create' is never persisted at all (spec: always re-prompt).
 */
export async function checkAgentPolicy(
  callerSlug: string,
  operation: XAgentOperation | 'create',
  targetSlug: string | null,
  targetName: string,
  preview?: string,
  fileTransfer?: XAgentFileTransfer,
  callerSessionId?: string,
  // The saved decision, when the route already started reading it (startRead).
  // Only the first read: a card's re-evaluations below always read again.
  savedDecision?: Promise<XAgentDecision>,
  runtime?: XAgentRuntime,
): Promise<PolicyOutcome> {
  // An agent acting on its own sessions crosses no agent boundary: no policy
  // applies and nobody is asked.
  if (targetSlug === callerSlug) return { allowed: true }
  if (operation !== 'create') {
    const decision = await (savedDecision ?? evaluatePolicy(callerSlug, operation, targetSlug))
    if (decision === 'allow') return { allowed: true }
    if (decision === 'block') return { allowed: false, reason: 'Blocked by policy' }
    // 'review' → fall through to interactive prompt
  }

  try {
    const reviews = agentRegistry.get(callerSlug).inputs.reviews
    const review = await awaitReview(reviews, (raise) => reviews.requestXAgent(
      { targetAgentSlug: targetSlug ?? '', targetAgentName: targetName, operation, preview, fileTransfer, runtime, callerSessionId },
      raise,
    ), operation === 'create' ? {} : {
      // When an "always" decision on another card changes the policy, this
      // request is decided again rather than released.
      reevaluate: async () => {
        const decision = await evaluatePolicy(callerSlug, operation, targetSlug)
        return decision === 'block' ? 'deny' : decision
      },
    })
    if (review.decision === 'deny') {
      return { allowed: false, reason: withUserReason('Denied by user.', review.reason) }
    }
    // A Block set while the card was open beats the approval.
    if (operation !== 'create' && await evaluatePolicy(callerSlug, operation, targetSlug) === 'block') {
      return { allowed: false, reason: 'Blocked by policy' }
    }
    return { allowed: true, pick: review.pick }
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : 'Review failed',
    }
  }
}

// ----------------------------------------------------------------------------
// The caller seam: what the operations ask, answered per kind of caller
// ----------------------------------------------------------------------------

/** Whether the caller holds at least `minRole` on the target (viewer to read, user to invoke). */
export function callerHasRoleOnTarget(caller: XAgentCaller, targetSlug: string, minRole: AgentRole): Promise<boolean> {
  if (caller.kind === 'agent') return callerOwnerHasRoleOnTarget(caller.agentSlug, targetSlug, minRole)
  return userHasMinRoleOnAgent({ id: caller.userId, isAdmin: caller.isAdmin }, targetSlug, minRole)
}

/** The agents the caller may list; null = no filter. */
export function callerVisibleAgentSlugs(caller: XAgentCaller): Promise<Set<string> | null> {
  if (caller.kind === 'agent') return visibleAgentSlugs(caller.agentSlug)
  return userVisibleAgentSlugs(caller)
}

/**
 * Start reading the saved policy decision for a later {@link checkCallerPolicy}.
 * Undefined when no policy applies: a user caller, or an agent on itself.
 */
export function startPolicyRead(
  caller: XAgentCaller,
  operation: XAgentOperation,
  targetSlug: string,
): Promise<XAgentDecision> | undefined {
  if (caller.kind !== 'agent') return undefined
  return startRead(evaluatePolicy(caller.agentSlug, operation, targetSlug))
}

/**
 * The xAgentPolicies check (with its review card) for an agent caller. A user
 * caller is authorized by its own role alone: no policy and no review.
 */
export function checkCallerPolicy(
  caller: XAgentCaller,
  operation: XAgentOperation,
  targetSlug: string | null,
  targetName: string,
  options: {
    preview?: string
    fileTransfer?: XAgentFileTransfer
    callerSessionId?: string
    savedDecision?: Promise<XAgentDecision>
    runtime?: XAgentRuntime
  } = {},
): Promise<PolicyOutcome> {
  if (caller.kind !== 'agent') return Promise.resolve({ allowed: true })
  return checkAgentPolicy(
    caller.agentSlug,
    operation,
    targetSlug,
    targetName,
    options.preview,
    options.fileTransfer,
    options.callerSessionId,
    options.savedDecision,
    options.runtime,
  )
}
