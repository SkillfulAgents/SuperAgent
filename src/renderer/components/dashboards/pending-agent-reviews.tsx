import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { ProxyReviewRequestItem } from '@renderer/components/messages/proxy-review-request-item'

interface PendingReview {
  id: string
  agentSlug: string
  accountId: string
  toolkit: string
  method: string
  targetPath: string
  matchedScopes: string[]
  scopeDescriptions: Record<string, string>
}

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
  const queryClient = useQueryClient()

  const { data, refetch } = useQuery<{ reviews: PendingReview[] }>({
    queryKey: ['proxy-reviews', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/proxy-reviews`)
      if (!res.ok) return { reviews: [] }
      return res.json()
    },
    // Safety-net poll in case SSE reconnects and misses an event.
    // Real-time path is GlobalNotificationHandler → setQueryData.
    refetchInterval: 30000,
  })

  const reviews = data?.reviews ?? []

  if (reviews.length === 0) return null

  return (
    <div className="space-y-2">
      {reviews.map((review) => (
        <ProxyReviewRequestItem
          key={review.id}
          reviewId={review.id}
          accountId={review.accountId}
          toolkit={review.toolkit}
          method={review.method}
          targetPath={review.targetPath}
          matchedScopes={review.matchedScopes}
          scopeDescriptions={review.scopeDescriptions}
          agentSlug={agentSlug}
          readOnly={readOnly}
          onComplete={() => {
            refetch()
            onReviewResolved?.()
          }}
        />
      ))}
    </div>
  )
}
