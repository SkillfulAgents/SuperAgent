/**
 * One agent's pending proxy and x-agent reviews: the store the actor owns.
 * The router in front of every agent's store is `review-manager`.
 */
import crypto from 'crypto'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { AgentInputRequests } from '@shared/lib/user-input/agent-input-requests'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'
import { generateReviewDisplayText, type ReviewDetails } from './review-display'
import { getScopeLabel, type ScopeLabel } from './scope-metadata'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

interface ReviewSettler {
  resolve: (decision: 'allow' | 'deny') => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
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
  const displayText =
    typeof p.displayText === 'string' && p.displayText.length > 0
      ? p.displayText
      : generateReviewDisplayText(toolkit, method, targetPath, scopeDescriptions, endpointDescription)
  return {
    agentSlug: entry.scope.agentSlug ?? '',
    accountId: typeof p.accountId === 'string' ? p.accountId : '',
    toolkit,
    method,
    targetPath,
    matchedScopes: Array.isArray(p.matchedScopes) ? (p.matchedScopes as string[]) : [],
    scopeDescriptions,
    ...(endpointDescription !== undefined ? { endpointDescription } : {}),
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
    action: { type: 'resolve'; decision: ReviewDecision } | { type: 'reject'; error: Error },
  ): void {
    const settler = this.settlers.get(entry.id)
    this.settlers.delete(entry.id)
    if (settler) clearTimeout(settler.timer)
    this.inputs.resolve(entry.id, outcome)
    if (settler) {
      if (action.type === 'resolve') settler.resolve(action.decision)
      else settler.reject(action.error)
    }
  }

  private settleDecided(entry: ReviewRegistryEntry, decision: ReviewDecision): void {
    this.settleReview(entry, decision === 'allow' ? 'answered' : 'declined', { type: 'resolve', decision })
  }

  request(details: ReviewRequest, signal?: AbortSignal): Promise<ReviewDecision> {
    const id = crypto.randomUUID()

    return new Promise<ReviewDecision>((resolve, reject) => {
      const settleTimedOut = () => {
        if (!this.settlers.has(id)) return
        this.settlers.delete(id)
        this.inputs.resolve(id, 'timeout')
        this.shadowSettlerCheck('settleTimedOut')
        this.syncAwaiting()
        reject(new Error('Review timeout'))
      }

      const timer = setTimeout(settleTimedOut, REVIEW_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timer)
        this.settlers.delete(id)
        this.inputs.resolve(id, 'cancelled')
        this.shadowSettlerCheck('abortCleanup')
        this.syncAwaiting()
      }

      // If the request is aborted (e.g. task stopped), clean up the orphaned review
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!this.settlers.has(id)) return // already resolved/timed out
          cleanup()
          reject(new Error('Request aborted'))
        }, { once: true })
      }

      this.settlers.set(id, { resolve, reject, timer })

      const displayText = generateReviewDisplayText(
        details.toolkit,
        details.method,
        details.targetPath,
        details.scopeDescriptions,
        details.endpointDescription,
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
        // ever drops it, fail the proxied call now — a review that exists
        // nowhere would otherwise park until the timeout.
        clearTimeout(timer)
        this.settlers.delete(id)
        reject(new Error('Failed to register review'))
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
      // (persister dispatchRequestNotification) — one per review, attributed
      // to the agent's first active session there.
    })
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
      if (!detailsOf(entry).matchedScopes.includes(scope)) continue
      this.settleDecided(entry, decision)
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
      const hasLabel = details.matchedScopes.some((s) => getScopeLabel(details.toolkit, s) === label)
      if (!hasLabel) continue
      this.settleDecided(entry, decision)
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
      if (detailsOf(entry).xAgent?.operation !== operation) continue
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
    targetAgentSlug: string,
    targetAgentName: string,
    operation: XAgentOperation,
    preview?: string,
    signal?: AbortSignal,
  ): Promise<ReviewDecision> {
    const scope =
      operation === 'list'
        ? 'list'
        : operation === 'create'
          ? 'create'
          : `${operation}:${targetAgentSlug}`
    const description =
      operation === 'create'
        ? `Allow agent to create a new agent named "${targetAgentName}"?`
        : operation === 'list'
          ? `Allow agent to list other agents in this workspace?`
          : operation === 'invoke'
            ? `Allow agent to send a message to "${targetAgentName}"?`
            : `Allow agent to read sessions of "${targetAgentName}"?`

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
        },
      },
      signal,
    )
  }

  denyAll(): void {
    for (const entry of this.entries()) {
      this.settleReview(entry, 'declined', { type: 'resolve', decision: 'deny' })
    }
    this.shadowSettlerCheck('denyAllForAgent')
    this.syncAwaiting()
  }

  /** Reject every parked review: the process is shutting down, or the agent is gone. */
  rejectAll(): void {
    const entries = this.entries()
    for (const entry of entries) {
      this.settleReview(entry, 'cancelled', { type: 'reject', error: new Error('Review timeout') })
    }
    // Defensive: a settler whose registry entry vanished is still a parked
    // proxied call — shutdown must never leave one hung.
    for (const [id, settler] of this.settlers) {
      clearTimeout(settler.timer)
      this.settlers.delete(id)
      settler.reject(new Error('Review timeout'))
    }
    if (entries.length > 0) this.syncAwaiting()
  }

  /** The ids of the parked proxied calls, for tests. */
  settlerIds(): string[] {
    return [...this.settlers.keys()]
  }
}
