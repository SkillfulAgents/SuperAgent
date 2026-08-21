import { useMemo } from 'react'
import { ProxyReviewRequestItem } from '@renderer/components/messages/proxy-review-request-item'
import { XAgentReviewRequestItem } from '@renderer/components/messages/x-agent-review-request-item'
import { AccountReauthRequestItem } from '@renderer/components/messages/account-reauth-request-item'
import { McpReauthRequestItem } from '@renderer/components/messages/mcp-reauth-request-item'
import {
  accountReauthFromEnvelope,
  mcpReauthFromEnvelope,
  reviewFromEnvelope,
  type PendingAccountReauth,
  type PendingMcpReauth,
  type PendingReview,
} from '@renderer/components/messages/use-pending-requests'
import { usePendingUserRequests } from '@renderer/hooks/use-pending-user-requests'

interface PendingAgentReviewsProps {
  agentSlug: string
  readOnly?: boolean
  onReviewResolved?: () => void
}

/**
 * Renders pending agent-scoped review and re-auth prompts from the unified
 * pending-requests snapshot — the same store every other request surface
 * reads. user_request_created / user_request_resolved SSE events invalidate
 * the query (GlobalNotificationHandler); the hook's interval refetch is the
 * safety net for a missed event.
 */
export function PendingAgentReviews({ agentSlug, readOnly, onReviewResolved }: PendingAgentReviewsProps) {
  const { data, refetch } = usePendingUserRequests(agentSlug)

  const actions = useMemo(() => {
    const out: Array<
      | { kind: 'review'; value: PendingReview }
      | { kind: 'account-reauth'; value: PendingAccountReauth }
      | { kind: 'mcp-reauth'; value: PendingMcpReauth }
    > = []
    for (const request of data ?? []) {
      const payload = request.payload as Record<string, unknown>
      if (request.kind === 'proxy_review' || request.kind === 'x_agent_review') {
        const review = reviewFromEnvelope(request, payload)
        if (review) out.push({ kind: 'review', value: review })
      } else if (request.kind === 'account_reauth_required') {
        const reauth = accountReauthFromEnvelope(request, payload)
        if (reauth) out.push({ kind: 'account-reauth', value: reauth })
      } else if (request.kind === 'mcp_reauth_required') {
        const reauth = mcpReauthFromEnvelope(request, payload)
        if (reauth) out.push({ kind: 'mcp-reauth', value: reauth })
      }
    }
    return out
  }, [data])

  if (actions.length === 0) return null

  return (
    <div className="space-y-2">
      {actions.map((action) => {
        const onComplete = () => {
          refetch()
          onReviewResolved?.()
        }
        if (action.kind === 'account-reauth') {
          const request = action.value
          return (
            <AccountReauthRequestItem
              key={request.id}
              proxyRequestId={request.proxyRequestId}
              accountId={request.accountId}
              toolkit={request.toolkit}
              accountStatus={request.accountStatus}
              agentSlug={agentSlug}
              readOnly={readOnly}
              onComplete={onComplete}
            />
          )
        }
        if (action.kind === 'mcp-reauth') {
          const request = action.value
          return (
            <McpReauthRequestItem
              key={request.id}
              proxyRequestId={request.proxyRequestId}
              mcpId={request.mcpId}
              mcpName={request.mcpName}
              authType={request.authType}
              agentSlug={agentSlug}
              readOnly={readOnly}
              onComplete={onComplete}
            />
          )
        }
        const review = action.value
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
