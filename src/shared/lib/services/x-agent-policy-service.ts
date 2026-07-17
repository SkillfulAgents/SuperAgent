/**
 * X-Agent Policy Service
 *
 * Tracks per-caller decisions for x-agent operations (list / read / invoke).
 * Mirrors the apiScopePolicies / mcpToolPolicies pattern.
 *
 * Operations:
 *   - 'list'   — caller can list other agents (target is null)
 *   - 'read'   — caller can read sessions/transcripts of target
 *   - 'invoke' — caller can send messages to target (implies 'read')
 *
 * 'create' is intentionally not stored — spec requires manual approval every time.
 */

import { randomUUID } from 'crypto'
import { z } from 'zod'
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { xAgentPolicies, type XAgentPolicy } from '@shared/lib/db/schema'

// ============================================================================
// Zod schemas (boundary validation per CLAUDE.md)
// ============================================================================

export const xAgentOperationSchema = z.enum(['list', 'read', 'invoke'])
export type XAgentOperation = z.infer<typeof xAgentOperationSchema>

export const xAgentDecisionSchema = z.enum(['allow', 'review', 'block'])
export type XAgentDecision = z.infer<typeof xAgentDecisionSchema>

export const xAgentPolicyRowSchema = z.object({
  id: z.string(),
  callerAgentSlug: z.string(),
  targetAgentSlug: z.string().nullable(),
  operation: xAgentOperationSchema,
  decision: xAgentDecisionSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type XAgentPolicyRow = z.infer<typeof xAgentPolicyRowSchema>

// ============================================================================
// Internal helpers
// ============================================================================

function targetMatch(target: string | null) {
  return target === null
    ? isNull(xAgentPolicies.targetAgentSlug)
    : eq(xAgentPolicies.targetAgentSlug, target)
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Look up an exact policy row.
 * For 'list', pass target=null. For 'read'/'invoke', pass target=<otherSlug>.
 */
export function getPolicy(
  callerSlug: string,
  operation: XAgentOperation,
  targetSlug: string | null,
): XAgentPolicy | null {
  const rows = db
    .select()
    .from(xAgentPolicies)
    .where(
      and(
        eq(xAgentPolicies.callerAgentSlug, callerSlug),
        eq(xAgentPolicies.operation, operation),
        targetMatch(targetSlug),
      ),
    )
    // Defense-in-depth: SQLite treats NULL targets as distinct in the unique
    // index, so a pre-existing duplicate global row could otherwise be resolved
    // non-deterministically. Order by updatedAt so the latest write always wins.
    .orderBy(desc(xAgentPolicies.updatedAt))
    .limit(1)
    .all()
  return rows[0] ?? null
}

/**
 * Upsert a policy row atomically.
 *
 * SQLite's unique-index semantics treat NULL != NULL, so a (caller, NULL, op)
 * row is not deduped by the unique index — two concurrent inserts could both
 * succeed and create duplicates. We wrap the read + insert/update in a
 * transaction so concurrent setPolicy calls serialize correctly.
 *
 * Returns Promise to keep the call-site signature stable; the actual work is
 * sync (better-sqlite3 transactions are synchronous). The result reports
 * whether a row was created and what it replaced, so single-policy callers
 * (the graph's drawn edges) can message accurately without a list round-trip.
 */
export async function setPolicy(
  callerSlug: string,
  operation: XAgentOperation,
  targetSlug: string | null,
  decision: XAgentDecision,
): Promise<{ created: boolean; previousDecision: XAgentDecision | null }> {
  const now = new Date()
  return db.transaction(() => {
    const existing = db
      .select()
      .from(xAgentPolicies)
      .where(
        and(
          eq(xAgentPolicies.callerAgentSlug, callerSlug),
          eq(xAgentPolicies.operation, operation),
          targetMatch(targetSlug),
        ),
      )
      .limit(1)
      .all()
    if (existing.length > 0) {
      db.update(xAgentPolicies)
        .set({ decision, updatedAt: now })
        .where(eq(xAgentPolicies.id, existing[0].id))
        .run()
      return { created: false, previousDecision: existing[0].decision as XAgentDecision }
    }
    db.insert(xAgentPolicies)
      .values({
        id: randomUUID(),
        callerAgentSlug: callerSlug,
        targetAgentSlug: targetSlug,
        operation,
        decision,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return { created: true, previousDecision: null }
  })
}

/**
 * Delete the specific-target policy rows for (caller, operation, target).
 * With `preserveBlock`, 'block' rows survive: revoking a granted edge must
 * not silently lift an explicit block (that would ESCALATE access — the
 * effective decision would fall back to a global allow, if one exists).
 * Returns the number of rows removed.
 */
export function deleteTargetPolicy(
  callerSlug: string,
  operation: XAgentOperation,
  targetSlug: string,
  options?: { preserveBlock?: boolean },
): number {
  const conditions = [
    eq(xAgentPolicies.callerAgentSlug, callerSlug),
    eq(xAgentPolicies.operation, operation),
    eq(xAgentPolicies.targetAgentSlug, targetSlug),
  ]
  if (options?.preserveBlock) {
    conditions.push(ne(xAgentPolicies.decision, 'block'))
  }
  const result = db
    .delete(xAgentPolicies)
    .where(and(...conditions))
    .run()
  return result.changes
}

/**
 * Evaluate the effective decision for an operation.
 * Returns 'allow' | 'review' | 'block'.
 *
 * Precedence (most-specific wins):
 *   1. Specific-target row (caller, op, target=X) — applies to that target only.
 *   2. Global row (caller, op, target=null) — applies when no specific row exists.
 *      For 'read'/'invoke' this is the "allow for all agents" form. For 'list'
 *      it's the only form (list has no target).
 *   3. Default: 'review' (interactive prompt).
 *
 * Each operation is independent — invoke does NOT imply read. This lets users
 * configure write-only access (invoke=allow, read=review/block) for cases
 * where one agent should be able to trigger another but not browse its history.
 *
 * Note: invoke_agent's sync=true response (which echoes the target's reply) is
 * part of the invoke contract and does not require 'read' — 'read' only gates
 * browsing existing sessions via get_agent_sessions / get_agent_session_transcript.
 */
export function evaluate(
  callerSlug: string,
  operation: XAgentOperation,
  targetSlug: string | null,
): XAgentDecision {
  if (targetSlug !== null) {
    const exact = getPolicy(callerSlug, operation, targetSlug)
    if (exact) return exact.decision
  }
  const global = getPolicy(callerSlug, operation, null)
  if (global) return global.decision
  return 'review'
}

/**
 * List all policy rows for a caller (used by UI to show current settings).
 */
export function listPoliciesForCaller(callerSlug: string): XAgentPolicy[] {
  return db
    .select()
    .from(xAgentPolicies)
    .where(eq(xAgentPolicies.callerAgentSlug, callerSlug))
    .all()
}

/**
 * Cascade-delete all policy rows referencing an agent (as caller OR target).
 * Call this from agent deletion flow.
 */
export async function deletePoliciesForAgent(agentSlug: string): Promise<void> {
  await db
    .delete(xAgentPolicies)
    .where(
      or(
        eq(xAgentPolicies.callerAgentSlug, agentSlug),
        eq(xAgentPolicies.targetAgentSlug, agentSlug),
      ),
    )
}

/**
 * Replace all policy rows for a caller in a single transaction.
 * Used by the per-agent policy editor UI.
 *
 * Decision semantics:
 *  - 'allow' / 'block' / 'review' → all persisted as a row.
 *    'review' is the implicit default for an absent row, but it is still stored
 *    when set explicitly: a per-target 'review' is a meaningful OVERRIDE of a
 *    global 'allow'/'block' (evaluate() resolves most-specific-first), and the
 *    editor relies on the row's presence to render the toggle as active.
 *  - To clear a setting back to the inherited default, omit the row entirely.
 *    The editor sends 'default' for that, which the API layer drops before
 *    calling here, so an absent row still resolves to 'review' in evaluate().
 */
export const replacePoliciesForCallerInputSchema = z.object({
  policies: z
    .array(
      z.object({
        operation: xAgentOperationSchema,
        targetSlug: z.string().nullable(),
        decision: xAgentDecisionSchema,
      }),
    )
    .max(500),
})
export type ReplacePoliciesForCallerInput = z.infer<typeof replacePoliciesForCallerInputSchema>

export function replacePoliciesForCaller(
  callerSlug: string,
  policies: ReplacePoliciesForCallerInput['policies'],
): void {
  const now = new Date()

  // Dedupe the payload before inserting. The (caller, target, operation) unique
  // index already rejects duplicate NON-null target rows, but SQLite treats NULL
  // as distinct, so two global entries like (alice, NULL, 'list') would both
  // persist and getPolicy/evaluate would resolve them non-deterministically
  // (limit(1)). Collapse global (null-target) entries per operation with
  // last-write-wins — later payload entries overwrite earlier ones — mirroring
  // the upsert semantics setPolicy uses for the same NULL-distinct case. Non-null
  // duplicates are intentionally left to the unique index (a client sending two
  // conflicting specific-target rows is an error and rolls back the transaction).
  const globalByOp = new Map<XAgentOperation, ReplacePoliciesForCallerInput['policies'][number]>()
  const specific: ReplacePoliciesForCallerInput['policies'] = []
  for (const p of policies) {
    if (p.targetSlug === null) {
      globalByOp.set(p.operation, p)
    } else {
      specific.push(p)
    }
  }
  const toInsert = [...specific, ...globalByOp.values()]

  db.transaction(() => {
    db.delete(xAgentPolicies)
      .where(eq(xAgentPolicies.callerAgentSlug, callerSlug))
      .run()
    for (const p of toInsert) {
      db.insert(xAgentPolicies)
        .values({
          id: randomUUID(),
          callerAgentSlug: callerSlug,
          targetAgentSlug: p.targetSlug,
          operation: p.operation,
          decision: p.decision,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  })
}
