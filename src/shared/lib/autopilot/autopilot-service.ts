import { mutateSessionAutopilot } from '@shared/lib/services/session-service'
import {
  DEFAULT_MAX_ITERATIONS,
  goalContractSchema,
  normalizeAutopilotState,
  type GoalContract,
  type WatchdogVerdict,
} from './autopilot-schema'

/**
 * State transitions for a session's autopilot block. Every transition runs
 * inside the serialized session-metadata mutator with its guard evaluated
 * under the lock, so concurrent events (watchdog verdict vs. user toggle vs.
 * user message) can't interleave into an illegal state.
 *
 * This module deliberately does NOT broadcast SSE — message-persister imports
 * session-service, so anything here must stay import-cycle-free. Callers emit
 * `session_updated` (messagePersister.broadcastSessionUpdate) after a
 * transition that returns true.
 */

/**
 * Agent-facing denial for host-managed approval gates (proxy API reviews, MCP
 * tool reviews, computer-use grants, host-script approvals, capability
 * reviews) hit while autopilot is engaged: instead of parking on a card the
 * user is not there to answer, the action is refused with guidance to work
 * around it or declare defeat. `action` is a short capitalized noun phrase,
 * e.g. "This API request".
 */
export function autopilotApprovalDeniedMessage(action: string): string {
  return (
    `${action} requires user approval, and this session is running in autopilot mode — the user has delegated the task and is not available to approve it. ` +
    `Find another way to accomplish the goal that does not need approval. ` +
    `If there is no viable alternative, do not retry the action — state plainly that you are blocked on user approval and on exactly what, then end your turn. The reviewer will pause autopilot and bring the user in.`
  )
}

/**
 * The user wants autopilot: off | paused → requested. Also engaged → requested
 * when a user message arrives with the switch still on — a user message
 * interrupts autonomy, so the agent must re-engage (possibly with an updated
 * contract) after addressing it.
 */
export async function requestAutopilot(agentSlug: string, sessionId: string): Promise<boolean> {
  return mutateSessionAutopilot(agentSlug, sessionId, (autopilot) => {
    const state = normalizeAutopilotState(autopilot?.state)
    if (state === 'requested') return false
    // requestedAt marks the start of the autopilot era — the judges bound
    // their evidence/intent windows to it (see autopilotEpochStartMs).
    return {
      ...autopilot,
      state: 'requested',
      pausedReason: undefined,
      requestedAt: new Date().toISOString(),
    }
  })
}

export type DisengageReason = 'user_toggle' | 'user_message' | 'completed'

/**
 * Drop back to interactive: any state → off. The goal contract is preserved
 * for provenance; iteration/pausedReason reset so a re-engage starts clean.
 */
export async function disengageAutopilot(
  agentSlug: string,
  sessionId: string,
  reason: DisengageReason
): Promise<boolean> {
  return mutateSessionAutopilot(agentSlug, sessionId, (autopilot) => {
    const state = normalizeAutopilotState(autopilot?.state)
    if (state === 'off') return false
    // A `done` verdict can land after the user already intervened (a mid-review
    // message flips engaged → requested). Completion only means anything for
    // the engaged session the watchdog reviewed — from any other state it
    // would silently kill an autopilot the user just re-requested.
    if (reason === 'completed' && state !== 'engaged') return false
    return {
      ...autopilot,
      state: 'off',
      pausedReason: reason === 'completed' ? undefined : autopilot?.pausedReason,
      lastVerdict: reason === 'completed' ? autopilot?.lastVerdict : undefined,
    }
  })
}

export type EngageResult = 'engaged' | 'not-requested' | 'invalid-contract'

/**
 * The agent called engage_autopilot: requested → engaged. The raw tool input
 * is Zod-parsed here (the host boundary); anything malformed rejects the
 * engagement rather than arming the watchdog on garbage.
 */
export async function engageAutopilot(
  agentSlug: string,
  sessionId: string,
  rawContract: unknown
): Promise<EngageResult> {
  const parsed = goalContractSchema.safeParse(rawContract)
  if (!parsed.success) return 'invalid-contract'
  const contract: GoalContract = parsed.data

  let result: EngageResult = 'not-requested'
  await mutateSessionAutopilot(agentSlug, sessionId, (autopilot) => {
    if (normalizeAutopilotState(autopilot?.state) !== 'requested') return false
    result = 'engaged'
    return {
      state: 'engaged',
      goal: contract,
      iteration: 0,
      // Preserve the era marker: the user's task statement precedes
      // engagement, and the judges' windows must include it.
      requestedAt: autopilot?.requestedAt,
      engagedAt: new Date().toISOString(),
    }
  })
  return result
}

/** Watchdog or mechanical guardrail: engaged → paused (+ reason for the user). */
export async function pauseAutopilot(
  agentSlug: string,
  sessionId: string,
  reason: string
): Promise<boolean> {
  return mutateSessionAutopilot(agentSlug, sessionId, (autopilot) => {
    if (normalizeAutopilotState(autopilot?.state) !== 'engaged') return false
    return { ...autopilot, state: 'paused', pausedReason: reason }
  })
}

export type ContinueDecision =
  | { action: 'continue'; iteration: number; maxIterations: number }
  | { action: 'escalate'; reason: 'iteration-cap' | 'no-progress'; iteration: number; maxIterations: number }
  | { action: 'not-engaged' }

/**
 * Apply a `continue` verdict under the lock: record it, run the two guardrails
 * (iteration cap; identical `missing` fingerprint twice in a row WITHOUT the
 * judge affirming progress = stall), and either burn an iteration or flip to
 * paused. Returning the decision from inside the mutator keeps the guard +
 * write atomic.
 */
export async function applyContinueVerdict(
  agentSlug: string,
  sessionId: string,
  verdict: WatchdogVerdict
): Promise<ContinueDecision> {
  let decision: ContinueDecision = { action: 'not-engaged' }
  await mutateSessionAutopilot(agentSlug, sessionId, (autopilot) => {
    if (!autopilot || normalizeAutopilotState(autopilot.state) !== 'engaged') return false

    const iteration = (autopilot.iteration ?? 0) + 1
    const maxIterations = autopilot.goal?.max_iterations ?? DEFAULT_MAX_ITERATIONS
    // No-progress fingerprint: prefer the validated criterion-index set (a
    // deterministic identity for "what is still missing"); fall back to the
    // judge's free-form `missing` string for verdicts without indexes.
    const fingerprint =
      verdict.missing_criteria && verdict.missing_criteria.length > 0
        ? `criteria:${[...new Set(verdict.missing_criteria)].sort((a, b) => a - b).join(',')}`
        : verdict.missing?.trim().toLowerCase()
    const lastVerdict = {
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
      missing: fingerprint,
      at: new Date().toISOString(),
    }

    if (iteration > maxIterations) {
      decision = { action: 'escalate', reason: 'iteration-cap', iteration, maxIterations }
      return { ...autopilot, state: 'paused', pausedReason: 'Iteration cap reached', lastVerdict }
    }

    // No-progress escalation needs BOTH signals: the same criteria are still
    // missing AND the judge — who saw the work done since the previous review —
    // did not affirm progress. Criterion identity alone is not a stall: a
    // multi-step criterion legitimately stays incomplete across several
    // reviews while real progress is made toward it.
    const previousMissing = autopilot.lastVerdict?.missing
    if (
      fingerprint &&
      previousMissing &&
      fingerprint === previousMissing.trim().toLowerCase() &&
      verdict.made_progress !== true
    ) {
      decision = { action: 'escalate', reason: 'no-progress', iteration, maxIterations }
      return {
        ...autopilot,
        state: 'paused',
        pausedReason: 'No progress across consecutive reviews',
        lastVerdict,
      }
    }

    decision = { action: 'continue', iteration, maxIterations }
    return { ...autopilot, iteration, lastVerdict }
  })
  return decision
}
