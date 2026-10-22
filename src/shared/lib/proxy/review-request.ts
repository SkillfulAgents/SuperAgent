/**
 * A proxied call's review, as the host waits for it: the card is raised on
 * the agent (its reviews hold it), the decision comes back as data, and a
 * sweep that changed the policy is decided again on the host, where the
 * policy and the rules are. The review's id is the host's, so an aborted
 * request withdraws its card.
 */
import { randomUUID } from 'crypto'
import type { ReviewDecision, ReviewOutcome, ReviewRequestOptions } from './agent-reviews'
import { background } from '../background'

/**
 * Decide the parked request again from scratch (policy and proxy rules), for
 * when a sibling's "always" decision changed the policy: 'allow' or 'deny'
 * settles it, 'review' leaves it for the person.
 */
export type ReviewReevaluator = () => Promise<'allow' | 'deny' | 'review'>

/** The agent's side of a parked review: what `ReviewOps` and `AgentReviews` both offer. */
export interface ReviewParking {
  withdraw(id: string): unknown
  resume(id: string): Promise<ReviewOutcome>
  settle(id: string, decision: ReviewDecision): Promise<ReviewOutcome>
}

/**
 * Raise a review with `raise` and wait for its decision. Throws when nobody
 * decides in time (`Review timeout`) or the request is aborted (`Request aborted`).
 */
export async function awaitReview(
  reviews: ReviewParking,
  raise: (options: ReviewRequestOptions) => Promise<ReviewOutcome>,
  options: { signal?: AbortSignal; reevaluate?: ReviewReevaluator } = {},
): Promise<ReviewDecision> {
  const { signal, reevaluate } = options
  // The caller is already gone: raise no card nobody waits on.
  if (signal?.aborted) throw new Error('Request aborted')
  const id = randomUUID()
  const withdraw = () => {
    background(Promise.resolve(reviews.withdraw(id)).catch((error: unknown) => {
      console.warn('[reviews] Failed to withdraw an aborted review:', error)
    }), { name: 'review-request.withdraw-review' })
  }
  signal?.addEventListener('abort', withdraw, { once: true })
  try {
    let outcome = await raise({ id, recheck: reevaluate !== undefined })
    while (outcome === 'recheck') {
      const again = await reevaluate!().catch((error: unknown) => {
        console.warn('[reviews] Re-evaluating a swept review failed; it stays pending:', error)
        return 'review' as const
      })
      outcome = again === 'review' ? await reviews.resume(id) : await reviews.settle(id, again)
    }
    if (outcome === 'timeout') throw new Error('Review timeout')
    if (outcome === 'withdrawn') throw new Error('Request aborted')
    return outcome
  } finally {
    signal?.removeEventListener('abort', withdraw)
  }
}
