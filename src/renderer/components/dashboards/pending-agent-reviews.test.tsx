// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PendingAgentReviews } from './pending-agent-reviews'

// The panel must render from the unified pending-requests snapshot — the
// same store every other surface reads — not the legacy proxy-review poll.

const mockUsePendingUserRequests = vi.fn()
vi.mock('@renderer/hooks/use-pending-user-requests', () => ({
  usePendingUserRequests: (agentSlug: string, sessionId?: string) =>
    mockUsePendingUserRequests(agentSlug, sessionId),
}))

const mockUsePendingProxyReviews = vi.fn(() => ({ data: { reviews: [] }, refetch: vi.fn() }))
vi.mock('@renderer/hooks/use-proxy-reviews', () => ({
  usePendingProxyReviews: () => mockUsePendingProxyReviews(),
}))

vi.mock('@renderer/components/messages/proxy-review-request-item', () => ({
  ProxyReviewRequestItem: ({ reviewId }: { reviewId: string }) => (
    <div data-testid={`proxy-review-${reviewId}`} />
  ),
}))
vi.mock('@renderer/components/messages/x-agent-review-request-item', () => ({
  XAgentReviewRequestItem: ({ reviewId }: { reviewId: string }) => (
    <div data-testid={`xagent-review-${reviewId}`} />
  ),
}))

function envelope(overrides: Record<string, unknown>) {
  return {
    id: 'rev-1',
    kind: 'proxy_review',
    scope: { agentSlug: 'agent-a' },
    blocking: true,
    autoApproved: false,
    payload: {
      accountId: 'acc-1',
      toolkit: 'github',
      method: 'GET',
      targetPath: '/user',
      matchedScopes: [],
      scopeDescriptions: {},
      displayText: 'Allow reading your GitHub profile?',
    },
    ...overrides,
  }
}

describe('PendingAgentReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUsePendingUserRequests.mockReturnValue({ data: undefined, refetch: vi.fn() })
  })

  it('renders proxy and x-agent review cards from the unified snapshot', () => {
    mockUsePendingUserRequests.mockReturnValue({
      data: [
        envelope({ id: 'rev-proxy-1' }),
        envelope({
          id: 'rev-xagent-1',
          kind: 'x_agent_review',
          payload: {
            accountId: 'acc-1',
            toolkit: 'x-agent',
            method: 'POST',
            targetPath: '/invoke',
            xAgent: {
              targetAgentSlug: 'agent-b',
              targetAgentName: 'Agent B',
              operation: 'invoke',
            },
          },
        }),
      ],
      refetch: vi.fn(),
    })

    render(<PendingAgentReviews agentSlug="agent-a" />)

    expect(screen.getByTestId('proxy-review-rev-proxy-1')).toBeTruthy()
    expect(screen.getByTestId('xagent-review-rev-xagent-1')).toBeTruthy()
    expect(mockUsePendingUserRequests).toHaveBeenCalledWith('agent-a', undefined)
  })

  it('ignores non-review kinds in the snapshot', () => {
    mockUsePendingUserRequests.mockReturnValue({
      data: [
        envelope({ id: 'rev-proxy-2' }),
        {
          id: 'tool-secret-1',
          kind: 'secret',
          scope: { agentSlug: 'agent-a', sessionId: 'sess-1' },
          blocking: true,
          autoApproved: false,
          payload: { secretName: 'API_KEY' },
        },
      ],
      refetch: vi.fn(),
    })

    const { container } = render(<PendingAgentReviews agentSlug="agent-a" />)

    expect(screen.getByTestId('proxy-review-rev-proxy-2')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid]')).toHaveLength(1)
  })

  it('renders nothing while the snapshot has never loaded', () => {
    const { container } = render(<PendingAgentReviews agentSlug="agent-a" />)
    expect(container.firstChild).toBeNull()
  })
})
