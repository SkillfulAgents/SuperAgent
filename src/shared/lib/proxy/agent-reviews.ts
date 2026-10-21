/**
 * One agent's pending proxy and x-agent reviews: the store the actor owns.
 * The router in front of every agent's store is `review-manager`.
 */
import { requiresOneTimeXAgentReview, type XAgentFileTransfer } from './x-agent-review'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { AgentInputRequests } from '@shared/lib/tools/requests/agent-input-requests'
import type { PendingUserInputRequest } from '@shared/lib/tools/requests/request-schema'
import { generateReviewDisplayText, type ReviewDetails } from './review-display'
import { heldByRequireRule, parseRuleProposal } from './rules/proposal-schema'
import { getScopeLabel, type ScopeLabel } from './scope-metadata'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * How a parked review ends for the call waiting on it:
 * - `allow` / `deny`: decided;
 * - `recheck`: an allow sweep changed the policy, and the caller asked to
 *   decide again itself (`recheck`): the review stays open until it settles
 *   or resumes it;
 * - `timeout`: nobody decided in time, or the agent was let go;
 * - `withdrawn`: the caller withdrew it (its request was aborted).
 */
export type ReviewOutcome = ReviewDecision | 'recheck' | 'timeout' | 'withdrawn'

export interface ReviewRequestOptions {
  /** The review's id, chosen by the caller so it can withdraw, resume or settle it. */
  id: string
  /** On an allow sweep, hand back `recheck` instead of releasing the call. */
  recheck?: boolean
}

interface ReviewSettler {
  /** The caller waiting for the next outcome; absent while it rechecks a sweep. */
  waiter?: (outcome: ReviewOutcome) => void
  timer: ReturnType<typeof setTimeout>
  recheck: boolean
}

type ReviewRegistryEntry = Extract<
  PendingUserInputRequest,
  { kind: 'proxy_review' | 'x_agent_review' }
>

export type ReviewDecision = 'allow' | 'deny'
export type XAgentOperation = 'list' | 'read' | 'invoke' | 'create'

/** What one agent's review needs to know; the agent itself is the store's. */
export type ReviewRequest = Omit<ReviewDetails, 'agentSlug'>

export function isReviewEntry(r: PendingUserInputRequest): r is ReviewRegistryEntry {
  return r.kind === 'proxy_review' || r.kind === 'x_agent_review'
}

// Rebuild ReviewDetails from an envelope payload. The payload schema is
// deliberately lenient, so every field gets a safe default; displayText is
// recomputed when the envelope predates it.
function detailsOf(entry: ReviewRegistryEntry): ReviewDetails & { displayText: string } {
  const p = entry.payload as Record<string, unknown>
  const toolkit = typeof p.toolkit === 'string' ? p.toolkit : ''
  const method = typeof p.method === 'string' ? p.method : ''
  const targetPath = typeof p.targetPath === 'string' ? p.targetPath : ''
  const scopeDescriptions =
    p.scopeDescriptions && typeof p.scopeDescriptions === 'object'
      ? (p.scopeDescriptions as Record<string, string>)
      : {}
  const endpointDescription =
    typeof p.endpointDescription === 'string' ? p.endpointDescription : undefined
  const endpointAmbiguous = p.endpointAmbiguous === true
  const displayText =
    typeof p.displayText === 'string' && p.displayText.length > 0
      ? p.displayText
      : generateReviewDisplayText(toolkit, method, targetPath, scopeDescriptions, endpointDescription, endpointAmbiguous)
  return {
    agentSlug: entry.scope.agentSlug ?? '',
    accountId: typeof p.accountId === 'string' ? p.accountId : '',
    ...(p.reviewType === 'api' || p.reviewType === 'mcp' ? { reviewType: p.reviewType } : {}),
    toolkit,
    method,
    targetPath,
    matchedScopes: Array.isArray(p.matchedScopes) ? (p.matchedScopes as string[]) : [],
    scopeDescriptions,
    ...(endpointDescription !== undefined ? { endpointDescription } : {}),
    ...(endpointAmbiguous ? { endpointAmbiguous } : {}),
    ...(typeof p.requestBody === 'string' ? { requestBody: p.requestBody } : {}),
    ...(Array.isArray(p.ruleOutcomes) && p.ruleOutcomes.length > 0
      ? { ruleOutcomes: p.ruleOutcomes as ReviewDetails['ruleOutcomes'] }
      : {}),
    ...(parseRuleProposal(p.ruleProposal) ? { ruleProposal: parseRuleProposal(p.ruleProposal) } : {}),
    ...(p.xAgent && typeof p.xAgent === 'object'
      ? { xAgent: p.xAgent as ReviewDetails['xAgent'] }
      : {}),
    displayText,
  }
}

/**
 * One agent's pending proxy and x-agent reviews.
 *
 * The agent's user-input store IS the pending-review store — each envelope's
 * payload carries the full ReviewDetails plus displayText. This class holds
 * only what an envelope cannot: the blocked proxied call's promise settlers
 * and the auto-deny timer. An entry without a settler is still a real review
 * (visible, decidable, sweepable); a settler without an entry is a leak the
 * shadow check flags.
 *
 * Owned by the agent's actor: a review can only ever be this agent's, so a
 * decision that reaches this store cannot settle another agent's review, and
 * dropping the actor rejects whatever is still parked.
 */
export class AgentReviews {
  private settlers: Map<string, ReviewSettler> = new Map()
  /** Outcomes that ended a review while its caller was rechecking: the caller's next resume takes them. */
  private readonly held = new Map<string, ReviewOutcome>()

  constructor(
    readonly slug: AgentSlug,
    private readonly inputs: AgentInputRequests,
    /** Recompute the agent's sessions' awaiting state after a review opens or settles. */
    private readonly syncAwaiting: () => void,
  ) {}

  private shadowSettlerCheck(context: string): void {
    if (process.env.NODE_ENV === 'production') return
    this.inputs.verifyReviewSettlerParity({
      context,
      settlerIds: [...this.settlers.keys()],
    })
  }

  private entries(): ReviewRegistryEntry[] {
    return this.inputs.getAgentScopedRequests().filter(isReviewEntry)
  }

  // The single exit: settles the registry entry, the parked promise (if one
  // exists), the auto-deny timer, and the UI broadcast together, in that
  // order — the registry must be settled before the promise resumes the
  // proxied call, which can re-enter and request another review.
  private settleReview(
    entry: ReviewRegistryEntry,
    outcome: 'answered' | 'declined' | 'cancelled' | 'timeout',
    result: ReviewOutcome,
  ): void {
    const settler = this.settlers.get(entry.id)
    this.settlers.delete(entry.id)
    if (settler) clearTimeout(settler.timer)
    this.inputs.resolve(entry.id, outcome)
    if (settler) this.handOver(entry.id, settler, result)
  }

  /** Give the caller its outcome, or keep it for the caller's next resume when it is rechecking. */
  private handOver(id: string, settler: ReviewSettler, outcome: ReviewOutcome): void {
    const waiter = settler.waiter
    settler.waiter = undefined
    if (waiter) waiter(outcome)
    else this.held.set(id, outcome)
  }

  private settleDecided(entry: ReviewRegistryEntry, decision: ReviewDecision): void {
    this.settleReview(entry, decision === 'allow' ? 'answered' : 'declined', decision)
  }

  /**
   * Settle a sibling review swept by an "always" decision on another one. A
   * deny sweep denies. An allow sweep doesn't release the request outright
   * when its caller asked to recheck: the caller decides it again under the
   * new policy (a require rule may still hold it) and settles or resumes it,
   * the review open meanwhile. A review whose caller did not ask (or one
   * already rechecking) is released unless a require rule held it.
   */
  private settleSwept(entry: ReviewRegistryEntry, decision: ReviewDecision): void {
    if (decision === 'deny') {
      this.settleDecided(entry, 'deny')
      return
    }
    const settler = this.settlers.get(entry.id)
    if (settler?.recheck) {
      if (settler.waiter) this.handOver(entry.id, settler, 'recheck')
      return
    }
    if (!heldByRequireRule(detailsOf(entry).ruleOutcomes)) this.settleDecided(entry, 'allow')
  }

  /**
   * Park the caller's proxied call on a review card until its outcome (see
   * `ReviewOutcome`). The caller names the review (`options.id`), so it can
   * withdraw it, and resume or settle it after a recheck.
   */
  request(details: ReviewRequest, options: ReviewRequestOptions): Promise<ReviewOutcome> {
    const { id } = options

    return new Promise<ReviewOutcome>((resolve) => {
      const settleTimedOut = () => {
        const settler = this.settlers.get(id)
        if (!settler) return
        this.settlers.delete(id)
        this.inputs.resolve(id, 'timeout')
        this.shadowSettlerCheck('settleTimedOut')
        this.syncAwaiting()
        this.handOver(id, settler, 'timeout')
      }

      // An id asked again replaces the call parked on it, which is told it
      // was withdrawn; its timer would otherwise time out the new one.
      const earlier = this.settlers.get(id)
      if (earlier) {
        clearTimeout(earlier.timer)
        earlier.waiter?.('withdrawn')
      }
      const timer = setTimeout(settleTimedOut, REVIEW_TIMEOUT_MS)
      this.settlers.set(id, { waiter: resolve, timer, recheck: options.recheck === true })

      const displayText = generateReviewDisplayText(
        details.toolkit,
        details.method,
        details.targetPath,
        details.scopeDescriptions,
        details.endpointDescription,
        details.endpointAmbiguous,
      )

      // Reviews are agent-scoped — no sessionId in the proxied call, so the
      // envelope carries agentSlug only. The registry entry IS the pending
      // review: it makes the agent's sessions read as awaiting, and its
      // payload carries the full details plus the derived display text so
      // every reader (unified wire, dashboard poll, sweeps) renders from it.
      const registered = this.inputs.register({
        id,
        kind: details.xAgent ? 'x_agent_review' : 'proxy_review',
        scope: { agentSlug: this.slug },
        blocking: true,
        autoApproved: false,
        payload: { ...details, agentSlug: this.slug, displayText },
      })
      if (!registered) {
        // Can't happen with our own envelope construction, but if the registry
        // ever drops it, end the proxied call now — a review that exists
        // nowhere would otherwise park until the timeout.
        clearTimeout(timer)
        this.settlers.delete(id)
        resolve('timeout')
        return
      }
      this.shadowSettlerCheck('requestReview')

      // The card reaches every surface off the registry's 'created'
      // transition (user_request_created on the global stream). Nothing here
      // re-announces the review on a channel of its own.

      // Recompute awaiting for the agent's sessions so chat tick / activity
      // strip stop lying "Working…" while the Allow/Deny card is up — the
      // registry entry registered above is what flips them.
      this.syncAwaiting()

      // The OS notification fires from the registry 'created' transition
      // (the live sessions' notifyRequest) — one per review, attributed
      // to the agent's first active session there.
    })
  }

  /**
   * The caller is gone (its request was aborted): close the card. Its parked
   * outcome, if it still waits on one, is `withdrawn`.
   */
  withdraw(id: string): void {
    this.held.delete(id)
    const entry = this.inputs.getOpenRequest(id)
    if (entry && isReviewEntry(entry) && this.settlers.has(id)) {
      this.settleReview(entry, 'cancelled', 'withdrawn')
      this.shadowSettlerCheck('withdraw')
      this.syncAwaiting()
    }
  }

  /**
   * After a recheck that found the review still needed: wait for its next
   * outcome. One that ended it during the recheck (a person decided, the
   * timer ran out) is handed back at once.
   */
  resume(id: string): Promise<ReviewOutcome> {
    const held = this.held.get(id)
    if (held !== undefined) {
      this.held.delete(id)
      return Promise.resolve(held)
    }
    const settler = this.settlers.get(id)
    if (!settler) return Promise.resolve('withdrawn')
    return new Promise<ReviewOutcome>((resolve) => {
      settler.waiter = resolve
    })
  }

  /**
   * After a recheck that decided the review: settle it so, unless it ended
   * meanwhile. Resolves to how it ended.
   */
  settle(id: string, decision: ReviewDecision): Promise<ReviewOutcome> {
    const outcome = this.resume(id)
    const entry = this.inputs.getOpenRequest(id)
    if (entry && isReviewEntry(entry) && this.settlers.has(id)) {
      this.settleDecided(entry, decision)
      this.shadowSettlerCheck('reevaluatedAfterSweep')
      this.syncAwaiting()
    }
    return outcome
  }

  /**
   * Resolve a pending review of this agent. A caller-supplied id that names
   * another agent's review, or a parked secret/question/computer-use wait, is
   * not found here: only this agent's review entries are consulted, so a
   * decision route can never settle a wait out from under its own flow.
   */
  submit(id: string, decision: ReviewDecision): boolean {
    const entry = this.inputs.getOpenRequest(id)
    // The kind guard is load-bearing: the decision routes accept a
    // caller-supplied id, and resolving whatever the store holds under it
    // would let a review decision settle a parked secret/question/computer-use
    // wait out from under its own decision flow.
    if (!entry || !isReviewEntry(entry)) return false

    this.settleDecided(entry, decision)
    this.shadowSettlerCheck('submitDecision')
    this.syncAwaiting()
    return true
  }

  resolveMatching(scope: string, decision: ReviewDecision): void {
    for (const entry of this.entries()) {
      const details = detailsOf(entry)
      if (decision === 'allow' && requiresOneTimeXAgentReview(details.xAgent)) continue
      if (!details.matchedScopes.includes(scope)) continue
      this.settleSwept(entry, decision)
    }
    this.shadowSettlerCheck('resolveMatchingPending')
    this.syncAwaiting()
  }

  /**
   * Resolve every pending API review whose matched scopes include one
   * carrying the given risk label. Used when the user picks "Allow all
   * <label>" — the saved policy is a label sentinel ('*read'/'*write'/
   * '*destructive') that `resolveMatching` (exact scope match) can't catch,
   * so sibling same-label prompts would otherwise sit until they time out.
   */
  resolveMatchingByLabel(label: ScopeLabel, decision: ReviewDecision): void {
    for (const entry of this.entries()) {
      const details = detailsOf(entry)
      if (decision === 'allow' && requiresOneTimeXAgentReview(details.xAgent)) continue
      const hasLabel = details.matchedScopes.some((s) => getScopeLabel(details.toolkit, s) === label)
      if (!hasLabel) continue
      this.settleSwept(entry, decision)
    }
    this.shadowSettlerCheck('resolveMatchingPendingByLabel')
    this.syncAwaiting()
  }

  /**
   * Resolve every pending x-agent review whose operation matches. Used when
   * the user picks "always allow for all agents" — the saved policy has
   * targetSlug=null, so the per-target scope match in `resolveMatching`
   * wouldn't catch sibling pending prompts (e.g. read:bob while saving global
   * read).
   */
  resolveMatchingXAgent(operation: XAgentOperation, decision: ReviewDecision): void {
    for (const entry of this.entries()) {
      const xAgent = detailsOf(entry).xAgent
      if (xAgent?.operation !== operation) continue
      if (decision === 'allow' && requiresOneTimeXAgentReview(xAgent)) continue
      this.settleDecided(entry, decision)
    }
    this.shadowSettlerCheck('resolveMatchingXAgentByOperation')
    this.syncAwaiting()
  }

  pending(): Array<{ id: string; displayText: string } & ReviewDetails> {
    return this.entries().map((entry) => ({ id: entry.id, ...detailsOf(entry) }))
  }

  /**
   * Convenience helper for x-agent reviews. Wraps `request` with a stable
   * scopeDescriptions/displayText that the dedicated UI renderer keys off.
   */
  requestXAgent(
    request: { targetAgentSlug: string; targetAgentName: string; operation: XAgentOperation; preview?: string; fileTransfer?: XAgentFileTransfer },
    options: ReviewRequestOptions,
  ): Promise<ReviewOutcome> {
    const { targetAgentSlug, targetAgentName, operation, preview, fileTransfer } = request
    const scope =
      operation === 'list'
        ? 'list'
        : operation === 'create'
          ? 'create'
          : `${operation}:${targetAgentSlug}`
    let description: string
    if (fileTransfer?.kind === 'download') {
      description = `Allow agent to download "${fileTransfer.filename}" from "${targetAgentName}"?`
    } else if (fileTransfer?.kind === 'send') {
      const count = fileTransfer.paths.length
      description = `Allow agent to send a message and ${count} ${count === 1 ? 'file' : 'files'} to "${targetAgentName}"?`
    } else {
      description = operation === 'create'
        ? `Allow agent to create a new agent named "${targetAgentName}"?`
        : operation === 'list'
          ? 'Allow agent to list other agents in this workspace?'
          : operation === 'read'
            ? `Allow agent to read sessions of "${targetAgentName}"?`
            : `Allow agent to send a message to "${targetAgentName}"?`
    }

    return this.request(
      {
        // Reuse fields semantically — accountId carries target slug for "always allow X" routing
        accountId: targetAgentSlug,
        toolkit: 'agents',
        method: operation,
        targetPath: `agents:${operation}:${targetAgentSlug}`,
        matchedScopes: [scope],
        scopeDescriptions: { [scope]: description },
        xAgent: {
          targetAgentSlug,
          targetAgentName,
          operation,
          preview,
          ...(fileTransfer ? { fileTransfer } : {}),
        },
      },
      options,
    )
  }

  denyAll(): void {
    for (const entry of this.entries()) {
      this.settleReview(entry, 'declined', 'deny')
    }
    this.shadowSettlerCheck('denyAllForAgent')
    this.syncAwaiting()
  }

  /** End every parked review as timed out: the process is shutting down, or the agent is gone. */
  rejectAll(): void {
    const entries = this.entries()
    for (const entry of entries) {
      this.settleReview(entry, 'cancelled', 'timeout')
    }
    // Defensive: a settler whose registry entry vanished is still a parked
    // proxied call — shutdown must never leave one hung.
    for (const [id, settler] of this.settlers) {
      clearTimeout(settler.timer)
      this.settlers.delete(id)
      this.handOver(id, settler, 'timeout')
    }
    if (entries.length > 0) this.syncAwaiting()
  }

  /** The ids of the parked proxied calls, for tests. */
  settlerIds(): string[] {
    return [...this.settlers.keys()]
  }
}
