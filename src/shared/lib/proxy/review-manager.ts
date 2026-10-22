import type { XAgentFileTransfer } from '@shared/lib/proxy/x-agent-review'
import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import type { AgentReviews, ReviewDecision, ReviewOutcome, ReviewRequest, ReviewRequestOptions, XAgentOperation } from './agent-reviews'
import type { ReviewDetails } from './review-display'
import { awaitReview, type ReviewReevaluator } from './review-request'
import type { ScopeLabel } from './scope-metadata'

export { generateReviewDisplayText, humanizeActionName, type ReviewDetails } from './review-display'
export { AgentReviews, type ReviewDecision, type ReviewOutcome, type ReviewRequest, type XAgentOperation } from './agent-reviews'

/**
 * The router in front of every agent's reviews. The reviews live in each
 * agent's actor (`AgentReviews`); this singleton dispatches the calls that
 * arrive with a slug (the proxy's `requestReview` for the agent a call came
 * from), finds the owner of a bare review id, and runs the shutdown sweep.
 */
export class ReviewManager {
  private readonly agents = new AttachedStores<AgentReviews>('reviews')

  /** Called once by the agent registry with the way to each agent's reviews. */
  attachAgents(directory: AgentStoreDirectory<AgentReviews> | null): void {
    this.agents.attach(directory)
  }

  /** Raise a review for the agent a call came from and wait for its decision (see `awaitReview`). */
  requestReview(details: ReviewDetails, signal?: AbortSignal, options?: { reevaluate?: ReviewReevaluator }): Promise<ReviewDecision> {
    const reviews = this.agents.get(details.agentSlug)
    return awaitReview(reviews, (raise) => reviews.request(details, raise), { signal, ...options })
  }

  /** `AgentReviews.request` on the agent's reviews: the outcome as data. */
  request(agentSlug: string, details: ReviewRequest, options: ReviewRequestOptions): Promise<ReviewOutcome> {
    return this.agents.get(agentSlug).request(details, options)
  }

  withdraw(agentSlug: string, id: string): void {
    this.agents.peek(agentSlug)?.withdraw(id)
  }

  resume(agentSlug: string, id: string): Promise<ReviewOutcome> {
    return this.agents.peek(agentSlug)?.resume(id) ?? Promise.resolve('withdrawn')
  }

  settle(agentSlug: string, id: string, decision: ReviewDecision): Promise<ReviewOutcome> {
    return this.agents.peek(agentSlug)?.settle(id, decision) ?? Promise.resolve('withdrawn')
  }

  /**
   * Resolve a pending review by id.
   *
   * `expectedAgentSlug` MUST be passed when the call originates from an
   * HTTP route — it guards against a user with role on agent A submitting
   * a decision for agent B's review by sending B's reviewId to A's URL.
   * Internal callers may omit it, in which case the review's owner decides.
   */
  submitDecision(id: string, decision: ReviewDecision, expectedAgentSlug?: string): boolean {
    // With the agent named, only its store is consulted: a review id another
    // agent holds is simply not found there — the same `false` shape as
    // "review not found", so nothing leaks to an unauthorized caller.
    if (expectedAgentSlug !== undefined) {
      return this.agents.peek(expectedAgentSlug)?.submit(id, decision) ?? false
    }
    const owner = userInputRequestManager.getOpenRequest(id)?.scope.agentSlug
    if (owner === undefined) return false
    return this.agents.peek(owner)?.submit(id, decision) ?? false
  }

  resolveMatchingPending(agentSlug: string, scope: string, decision: ReviewDecision): void {
    this.agents.peek(agentSlug)?.resolveMatching(scope, decision)
  }

  resolveMatchingPendingByLabel(agentSlug: string, label: ScopeLabel, decision: ReviewDecision): void {
    this.agents.peek(agentSlug)?.resolveMatchingByLabel(label, decision)
  }

  resolveMatchingXAgentByOperation(agentSlug: string, operation: XAgentOperation, decision: ReviewDecision): void {
    this.agents.peek(agentSlug)?.resolveMatchingXAgent(operation, decision)
  }

  getPendingReviewsForAgent(agentSlug: string): Array<{ id: string; displayText: string } & ReviewDetails> {
    return this.agents.peek(agentSlug)?.pending() ?? []
  }

  /** Raise an x-agent review for the calling agent and wait for its decision (see `awaitReview`). */
  requestXAgentReview(
    callerAgentSlug: string,
    targetAgentSlug: string,
    targetAgentName: string,
    operation: XAgentOperation,
    preview?: string,
    fileTransfer?: XAgentFileTransfer,
    signal?: AbortSignal,
  ): Promise<ReviewDecision> {
    const reviews = this.agents.get(callerAgentSlug)
    return awaitReview(reviews, (raise) => reviews.requestXAgent({ targetAgentSlug, targetAgentName, operation, preview, fileTransfer }, raise), { signal })
  }

  /** `AgentReviews.requestXAgent` on the calling agent's reviews: the outcome as data. */
  requestXAgent(
    callerAgentSlug: string,
    request: { targetAgentSlug: string; targetAgentName: string; operation: XAgentOperation; preview?: string; fileTransfer?: XAgentFileTransfer },
    options: ReviewRequestOptions,
  ): Promise<ReviewOutcome> {
    return this.agents.get(callerAgentSlug).requestXAgent(request, options)
  }

  denyAllForAgent(agentSlug: string): void {
    this.agents.peek(agentSlug)?.denyAll()
  }

  rejectAll(): void {
    for (const reviews of this.agents.all()) reviews.rejectAll()
  }
}

// Use globalThis to persist across dev-server hot reloads, matching the
// agents' state (see `createAgentRegistry`). The two are coupled: pending
// reviews live in the agents' actors and write through to their user-input
// stores (which drive the live sessions' awaiting projection), and that state
// survives reloads — so the router in front of it must too.
const globalForReviewManager = globalThis as unknown as {
  reviewManager: ReviewManager | undefined
}

export const reviewManager = globalForReviewManager.reviewManager ?? new ReviewManager()

if (process.env.NODE_ENV !== 'production') {
  globalForReviewManager.reviewManager = reviewManager
}
