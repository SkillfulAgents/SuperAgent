import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockBroadcastGlobal = vi.fn()

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: (...args: unknown[]) => mockBroadcastGlobal(...args),
  },
}))

import { broadcastReview } from './review-broadcast'

describe('broadcastReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends a single global event with type session_awaiting_input', () => {
    broadcastReview('my-agent', { type: 'proxy_review_request', reviewId: 'r1' })

    expect(mockBroadcastGlobal).toHaveBeenCalledOnce()
    const event = mockBroadcastGlobal.mock.calls[0][0]
    expect(event.type).toBe('session_awaiting_input')
  })

  it('includes agentSlug at top level', () => {
    broadcastReview('my-agent', { type: 'proxy_review_request' })

    const event = mockBroadcastGlobal.mock.calls[0][0]
    expect(event.agentSlug).toBe('my-agent')
  })

  it('nests review data under review key (does NOT spread into top-level)', () => {
    const reviewData = {
      type: 'proxy_review_request',
      reviewId: 'r1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/gmail/v1/messages',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: { 'gmail.readonly': 'Read email' },
    }

    broadcastReview('my-agent', reviewData)

    const event = mockBroadcastGlobal.mock.calls[0][0]
    // Top-level type must NOT be overwritten by the review data
    expect(event.type).toBe('session_awaiting_input')
    // Review data accessible under .review
    expect(event.review).toEqual(reviewData)
    expect(event.review.type).toBe('proxy_review_request')
    expect(event.review.reviewId).toBe('r1')
  })

  it('handles proxy_review_resolved events the same way', () => {
    broadcastReview('my-agent', { type: 'proxy_review_resolved', reviewId: 'r1', decision: 'allow' })

    const event = mockBroadcastGlobal.mock.calls[0][0]
    expect(event.type).toBe('session_awaiting_input')
    expect(event.review.type).toBe('proxy_review_resolved')
    expect(event.review.decision).toBe('allow')
  })
})
