import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import { isReviewEntry, type AgentReviews, type ReviewDecision, type XAgentOperation } from './agent-reviews'
import type { ReviewDetails } from './review-display'
import type { ScopeLabel } from './scope-metadata'

export { generateReviewDisplayText, humanizeActionName, type ReviewDetails } from './review-display'
export { AgentReviews, type ReviewDecision, type ReviewRequest, type XAgentOperation } from './agent-reviews'

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

  requestReview(details: ReviewDetails, signal?: AbortSignal): Promise<ReviewDecision> {
    return this.agents.get(details.agentSlug).request(details, signal)
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
    const entry = userInputRequestManager.getOpenRequest(id)
    if (!entry || !isReviewEntry(entry)) return false
    const owner = entry.scope.agentSlug
    if (owner === undefined) return false
    if (expectedAgentSlug !== undefined && owner !== expectedAgentSlug) {
      // Don't leak existence of the review to an unauthorized caller —
      // return the same `false` shape as "review not found".
      return false
    }
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

  requestXAgentReview(
    callerAgentSlug: string,
    targetAgentSlug: string,
    targetAgentName: string,
    operation: XAgentOperation,
    preview?: string,
    signal?: AbortSignal,
  ): Promise<ReviewDecision> {
    return this.agents.get(callerAgentSlug).requestXAgent(targetAgentSlug, targetAgentName, operation, preview, signal)
  }

  denyAllForAgent(agentSlug: string): void {
    this.agents.peek(agentSlug)?.denyAll()
  }

  rejectAll(): void {
    for (const reviews of this.agents.all()) reviews.rejectAll()
  }
}

// Use globalThis to persist across dev-server hot reloads, matching
// messagePersister. The two are coupled: pending reviews write through to the
// agents' user-input stores (which drive the persister's awaiting projection),
// and both singletons survive reloads — so reviewManager must too, or a reload
// would strand its pending reviews in a stale instance.
const globalForReviewManager = globalThis as unknown as {
  reviewManager: ReviewManager | undefined
}

export const reviewManager = globalForReviewManager.reviewManager ?? new ReviewManager()

if (process.env.NODE_ENV !== 'production') {
  globalForReviewManager.reviewManager = reviewManager
}
