import { ProxyReviewRequestItem } from '@renderer/components/messages/proxy-review-request-item'
import { XAgentReviewRequestItem } from '@renderer/components/messages/x-agent-review-request-item'
import { usePendingProxyReviews } from '@renderer/hooks/use-proxy-reviews'

interface PendingAgentReviewsProps {
  agentSlug: string
  readOnly?: boolean
  onReviewResolved?: () => void
}

/**
 * Renders pending proxy review prompts for an agent.
 *
 * Real-time updates come from GlobalNotificationHandler which writes
 * directly into the ['proxy-reviews', agentSlug] query cache when
 * proxy_review_request / proxy_review_resolved events arrive via SSE.
 *
 * The 30s poll is a safety net only (e.g. if SSE reconnects and misses
 * an event). It is NOT the primary delivery mechanism.
 */
export function PendingAgentReviews({ agentSlug, readOnly, onReviewResolved }: PendingAgentReviewsProps) {
  const { data, refetch } = usePendingProxyReviews(agentSlug)

  const reviews = data?.reviews ?? []

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
