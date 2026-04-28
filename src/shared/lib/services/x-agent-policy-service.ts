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
import { and, eq, isNull, or } from 'drizzle-orm'
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
 * sync (better-sqlite3 transactions are synchronous).
 */
export async function setPolicy(
  callerSlug: string,
  operation: XAgentOperation,
  targetSlug: string | null,
  decision: XAgentDecision,
): Promise<void> {
  const now = new Date()
  db.transaction(() => {
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
      return
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
  })
}

/**
 * Evaluate the effective decision for an operation.
 * Returns 'allow' | 'review' | 'block'.
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
  const exact = getPolicy(callerSlug, operation, targetSlug)
  if (exact) return exact.decision
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
 *  - 'allow' / 'block' → persisted as a row.
 *  - 'review' → NOT persisted (treated as the implicit default for absent rows).
 *    This is intentional: storing a 'review' row adds no behavior and just bloats
 *    the table. Round-tripping {operation, target, decision: 'review'} through
 *    PUT then GET will see the row disappear — clients should treat the absence
 *    of a row as 'review' and render it that way.
 */
export const replacePoliciesForCallerInputSchema = z.object({
  policies: z
    .array(
      z.object({
        operation: xAgentOperationSchema,
        targetSlug: z.string().nullable(),
        // 'review' is accepted but not persisted (see docstring above).
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
  db.transaction(() => {
    db.delete(xAgentPolicies)
      .where(eq(xAgentPolicies.callerAgentSlug, callerSlug))
      .run()
    for (const p of policies) {
      // Skip the implicit-default 'review' state — it's the default if no row exists,
      // so storing it adds no value and just bloats the table.
      if (p.decision === 'review') continue
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
