import { z } from 'zod'

/**
 * Autopilot: the agent sees a task through autonomously. A session carries an
 * autopilot block in its metadata; the watchdog reviews every stop against the
 * goal contract the agent declared when it engaged.
 *
 * State machine (session-level):
 *   off ──(user toggles switch)──▶ requested ──(agent calls engage_autopilot)──▶ engaged
 *   engaged ──(watchdog: done)──▶ off
 *   engaged ──(watchdog: blocked / guardrail tripped)──▶ paused
 *   engaged ──(user sends a message)──▶ off  (user message = disengage)
 *   requested ──(user toggles off)──▶ off
 *   paused ──(user toggles on again)──▶ requested
 */

export const AUTOPILOT_STATES = ['off', 'requested', 'engaged', 'paused'] as const
export type AutopilotState = (typeof AUTOPILOT_STATES)[number]

/** Continues the watchdog may spend before escalating, when the agent didn't set one. */
export const DEFAULT_MAX_ITERATIONS = 10
/** Hard ceiling on agent-requested iteration budgets. */
export const MAX_ITERATIONS_CEILING = 50

/**
 * The goal contract — the engage_autopilot tool args. The agent restates the
 * task as explicit success criteria; the watchdog judges against THIS, not the
 * raw prompt. Parsed with `.parse()` when the host observes the tool call, and
 * again when read back from session metadata.
 */
export const goalContractSchema = z
  .object({
    goal: z.string().min(1),
    success_criteria: z.array(z.string().min(1)).min(1),
    max_iterations: z.number().int().positive().max(MAX_ITERATIONS_CEILING).optional(),
  })
  .loose()

export type GoalContract = z.infer<typeof goalContractSchema>

/**
 * Watchdog verdict, three-way by design:
 *  - done: success criteria satisfied → session rests, autopilot completes.
 *  - continue: not done but unblocked → `nudge` is injected as the continuation
 *    prompt (a bare "keep going" degrades fast, so the nudge is required).
 *  - blocked: needs the user (auth, decision, destructive action) → pause + notify.
 * `missing` is a terse fingerprint of what's still outstanding; two identical
 * fingerprints in a row are the no-progress guardrail's escalation signal.
 */
export const watchdogVerdictSchema = z.object({
  verdict: z.enum(['done', 'continue', 'blocked']),
  reasoning: z.string(),
  // The prompt marks these "REQUIRED for continue", so on done/blocked the
  // judge often emits them as explicit nulls — accept and drop them rather
  // than fail the whole verdict (which would wrongly escalate a clean done).
  nudge: z
    .string()
    .nullable()
    .transform((v) => v ?? undefined)
    .optional(),
  missing: z
    .string()
    .nullable()
    .transform((v) => v ?? undefined)
    .optional(),
})

export type WatchdogVerdict = z.infer<typeof watchdogVerdictSchema>

/**
 * The autopilot block persisted on SessionMetadata. Lenient (`.loose()`, bare
 * string state) for the same reason as the rest of session-metadata-schema: a
 * newer build's value must never wedge an older reader. Consumers narrow via
 * `normalizeAutopilotState` at the point of use.
 */
export const autopilotMetadataSchema = z
  .object({
    state: z.string(),
    goal: goalContractSchema.optional(),
    iteration: z.number().optional(),
    engagedAt: z.string().optional(),
    pausedReason: z.string().optional(),
    lastVerdict: z
      .object({
        verdict: z.string(),
        reasoning: z.string().optional(),
        missing: z.string().optional(),
        at: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose()

export type AutopilotMetadata = z.infer<typeof autopilotMetadataSchema>

export function normalizeAutopilotState(value: string | undefined | null): AutopilotState {
  return (AUTOPILOT_STATES as readonly string[]).includes(value ?? '')
    ? (value as AutopilotState)
    : 'off'
}

/**
 * Approval-reviewer verdict: while engaged, review-tier API/MCP requests are
 * judged by a model that sees ONLY the user's own messages plus the requested
 * action — never the agent trajectory — so prompt injections in tool outputs
 * or web content cannot reach the decision. The reason is recorded in the
 * request audit log either way.
 */
export const approvalReviewVerdictSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  reason: z.string().min(1),
})

export type ApprovalReviewVerdict = z.infer<typeof approvalReviewVerdictSchema>

/**
 * Timeline-entry payload for an autopilot decision (stored JSON-stringified in
 * a `type: 'system', subtype: 'autopilot_review'` JSONL entry; parsed with
 * this schema when the transcript is transformed for the API). Two producers
 * share the shape: the watchdog's stop reviews (done/continue/blocked/
 * escalated, with nudge + iteration bookkeeping) and the approval reviewer's
 * per-request decisions (approved/denied, with `action` naming the API/MCP
 * call that was judged).
 */
export const autopilotReviewEntrySchema = z
  .object({
    verdict: z.enum(['done', 'continue', 'blocked', 'escalated', 'approved', 'denied']),
    reasoning: z.string(),
    nudge: z.string().optional(),
    action: z.string().optional(),
    iteration: z.number().optional(),
    maxIterations: z.number().optional(),
  })
  .loose()

export type AutopilotReviewEntry = z.infer<typeof autopilotReviewEntrySchema>
