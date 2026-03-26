import crypto from 'crypto'
import { broadcastReview } from './review-broadcast'

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface ReviewDetails {
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
}

interface PendingReview {
  id: string
  details: ReviewDetails
  resolve: (decision: 'allow' | 'deny') => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ReviewManager {
  private pending: Map<string, PendingReview> = new Map()

  requestReview(details: ReviewDetails): Promise<'allow' | 'deny'> {
    const id = crypto.randomUUID()

    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Review timeout'))
      }, REVIEW_TIMEOUT_MS)

      this.pending.set(id, { id, details, resolve, reject, timer })

      // Broadcast review request to agent's active sessions
      broadcastReview(details.agentSlug, {
        type: 'proxy_review_request',
        reviewId: id,
        accountId: details.accountId,
        toolkit: details.toolkit,
        method: details.method,
        targetPath: details.targetPath,
        matchedScopes: details.matchedScopes,
        scopeDescriptions: details.scopeDescriptions,
      })
    })
  }

  submitDecision(id: string, decision: 'allow' | 'deny'): boolean {
    const review = this.pending.get(id)
    if (!review) return false

    clearTimeout(review.timer)
    this.pending.delete(id)
    review.resolve(decision)

    // Broadcast resolution so UIs can dismiss the prompt
    broadcastReview(review.details.agentSlug, {
      type: 'proxy_review_resolved',
      reviewId: id,
      decision,
    })

    return true
  }

  resolveMatchingPending(
    agentSlug: string,
    scope: string,
    decision: 'allow' | 'deny'
  ): void {
    for (const [id, review] of this.pending) {
      if (
        review.details.agentSlug === agentSlug &&
        review.details.matchedScopes.includes(scope)
      ) {
        clearTimeout(review.timer)
        this.pending.delete(id)
        review.resolve(decision)

        broadcastReview(agentSlug, {
          type: 'proxy_review_resolved',
          reviewId: id,
          decision,
        })
      }
    }
  }

  getPendingReviewsForAgent(
    agentSlug: string
  ): Array<{ id: string } & ReviewDetails> {
    const results: Array<{ id: string } & ReviewDetails> = []
    for (const review of this.pending.values()) {
      if (review.details.agentSlug === agentSlug) {
        results.push({ id: review.id, ...review.details })
      }
    }
    return results
  }

  rejectAll(): void {
    for (const [id, review] of this.pending) {
      clearTimeout(review.timer)
      this.pending.delete(id)
      review.reject(new Error('Review timeout'))
    }
  }
}

export const reviewManager = new ReviewManager()
