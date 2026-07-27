import { useMemo } from 'react'
import { ProxyReviewRequestItem } from '@renderer/components/messages/proxy-review-request-item'
import { XAgentReviewRequestItem } from '@renderer/components/messages/x-agent-review-request-item'
import { reviewFromEnvelope } from '@renderer/components/messages/use-pending-requests'
import { usePendingUserRequests } from '@renderer/hooks/use-pending-user-requests'
import type { PendingReview } from '@renderer/hooks/use-proxy-reviews'

interface PendingAgentReviewsProps {
  agentSlug: string
  readOnly?: boolean
  onReviewResolved?: () => void
}

/**
 * Renders pending proxy review prompts for an agent, from the unified
 * pending-requests snapshot — the same store every other request surface
 * reads. user_request_created / user_request_resolved SSE events invalidate
 * the query (GlobalNotificationHandler); the hook's interval refetch is the
 * safety net for a missed event.
 */
export function PendingAgentReviews({ agentSlug, readOnly, onReviewResolved }: PendingAgentReviewsProps) {
  const { data, refetch } = usePendingUserRequests(agentSlug)

  const reviews = useMemo(() => {
    const out: PendingReview[] = []
    for (const request of data ?? []) {
      if (request.kind !== 'proxy_review' && request.kind !== 'x_agent_review') continue
      const review = reviewFromEnvelope(request, request.payload as Record<string, unknown>)
      if (review) out.push(review)
    }
    return out
  }, [data])

  if (reviews.length === 0) return null

  return (
    <div className="space-y-2">
      {reviews.map((review) => {
        const onComplete = () => {
          refetch()
          onReviewResolved?.()
        }
        if (review.xAgent) {
          return (
            <XAgentReviewRequestItem
              key={review.id}
              reviewId={review.id}
              agentSlug={agentSlug}
              xAgent={review.xAgent}
              readOnly={readOnly}
              onComplete={onComplete}
            />
          )
        }
        return (
          <ProxyReviewRequestItem
            key={review.id}
            reviewId={review.id}
            accountId={review.accountId}
            toolkit={review.toolkit}
            method={review.method}
            targetPath={review.targetPath}
            matchedScopes={review.matchedScopes}
            scopeDescriptions={review.scopeDescriptions}
            displayText={review.displayText}
            agentSlug={agentSlug}
            readOnly={readOnly}
            onComplete={onComplete}
          />
        )
      })}
    </div>
  )
}
