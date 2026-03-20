import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the broadcast function
const mockBroadcastReview = vi.fn()
vi.mock('./review-broadcast', () => ({
  broadcastReview: (...args: unknown[]) => mockBroadcastReview(...args),
}))

import { ReviewManager } from './review-manager'

describe('ReviewManager', () => {
  let manager: ReviewManager

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    manager = new ReviewManager()
  })

  afterEach(() => {
    manager.rejectAll()
    vi.useRealTimers()
  })

  it('requestReview → submitDecision("allow") resolves to "allow"', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/gmail/v1/users/me/messages',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: { 'gmail.readonly': 'Read email' },
    })

    // Get the review ID from pending reviews
    const pending = manager.getPendingReviewsForAgent('agent-1')
    expect(pending.length).toBe(1)
    const reviewId = pending[0].id

    manager.submitDecision(reviewId, 'allow')
    const result = await promise
    expect(result).toBe('allow')
  })

  it('requestReview → submitDecision("deny") resolves to "deny"', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'DELETE',
      targetPath: '/gmail/v1/users/me/messages/123',
      matchedScopes: ['gmail.full'],
      scopeDescriptions: {},
    })

    const pending = manager.getPendingReviewsForAgent('agent-1')
    const reviewId = pending[0].id

    manager.submitDecision(reviewId, 'deny')
    const result = await promise
    expect(result).toBe('deny')
  })

  it('submitDecision returns false for unknown reviewId', () => {
    const result = manager.submitDecision('nonexistent-id', 'allow')
    expect(result).toBe(false)
  })

  it('submitDecision returns true for valid reviewId', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    const pending = manager.getPendingReviewsForAgent('agent-1')
    const reviewId = pending[0].id

    const result = manager.submitDecision(reviewId, 'allow')
    expect(result).toBe(true)
    await promise
  })

  it('timeout after 5 minutes rejects with Error("Review timeout")', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    await expect(promise).rejects.toThrow('Review timeout')
  })

  it('after timeout, submitDecision returns false (entry cleaned up)', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    const pending = manager.getPendingReviewsForAgent('agent-1')
    const reviewId = pending[0].id

    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    await promise.catch(() => {}) // consume rejection

    expect(manager.submitDecision(reviewId, 'allow')).toBe(false)
  })

  it('submitDecision clears timeout (advancing past 5min after submit does not reject)', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    const pending = manager.getPendingReviewsForAgent('agent-1')
    const reviewId = pending[0].id

    manager.submitDecision(reviewId, 'allow')
    const result = await promise
    expect(result).toBe('allow')

    // Advancing time should NOT cause any rejection
    vi.advanceTimersByTime(10 * 60 * 1000)
    // If the timeout wasn't cleared, this test would fail with unhandled rejection
  })

  it('resolveMatchingPending auto-resolves reviews with matching scope', async () => {
    const promise1 = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path1',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
    })

    const promise2 = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-2',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path2',
      matchedScopes: ['gmail.readonly', 'gmail.modify'],
      scopeDescriptions: {},
    })

    manager.resolveMatchingPending('agent-1', 'gmail.readonly', 'allow')

    const result1 = await promise1
    const result2 = await promise2
    expect(result1).toBe('allow')
    expect(result2).toBe('allow')
  })

  it('resolveMatchingPending does NOT resolve reviews with non-matching scopes', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'DELETE',
      targetPath: '/path',
      matchedScopes: ['gmail.full'],
      scopeDescriptions: {},
    })

    manager.resolveMatchingPending('agent-1', 'gmail.readonly', 'allow')

    // Should still be pending
    const pending = manager.getPendingReviewsForAgent('agent-1')
    expect(pending.length).toBe(1)

    // Clean up
    const reviewId = pending[0].id
    manager.submitDecision(reviewId, 'deny')
    await promise
  })

  it('rejectAll rejects all pending promises', async () => {
    const promise1 = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path1',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    const promise2 = manager.requestReview({
      agentSlug: 'agent-2',
      accountId: 'acc-2',
      toolkit: 'slack',
      method: 'POST',
      targetPath: '/path2',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    manager.rejectAll()

    await expect(promise1).rejects.toThrow('Review timeout')
    await expect(promise2).rejects.toThrow('Review timeout')
  })

  it('broadcast function called on requestReview with correct details', async () => {
    const details = {
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/gmail/v1/users/me/messages',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: { 'gmail.readonly': 'Read email' },
    }

    const promise = manager.requestReview(details)

    expect(mockBroadcastReview).toHaveBeenCalledOnce()
    const [agentSlug, event] = mockBroadcastReview.mock.calls[0]
    expect(agentSlug).toBe('agent-1')
    expect(event.type).toBe('proxy_review_request')
    expect(event.toolkit).toBe('gmail')
    expect(event.matchedScopes).toEqual(['gmail.readonly'])

    // Clean up
    const pending = manager.getPendingReviewsForAgent('agent-1')
    manager.submitDecision(pending[0].id, 'allow')
    await promise
  })

  it('submitDecision broadcasts proxy_review_resolved event', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
    })

    mockBroadcastReview.mockClear()
    const pending = manager.getPendingReviewsForAgent('agent-1')
    manager.submitDecision(pending[0].id, 'allow')
    await promise

    expect(mockBroadcastReview).toHaveBeenCalledOnce()
    const [agentSlug, event] = mockBroadcastReview.mock.calls[0]
    expect(agentSlug).toBe('agent-1')
    expect(event.type).toBe('proxy_review_resolved')
    expect(event.reviewId).toBe(pending[0].id)
    expect(event.decision).toBe('allow')
  })

  it('resolveMatchingPending broadcasts proxy_review_resolved for each resolved review', async () => {
    const promise1 = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path1',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
    })
    const promise2 = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-2',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path2',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
    })

    // 2 broadcasts for requestReview + clear
    mockBroadcastReview.mockClear()

    manager.resolveMatchingPending('agent-1', 'gmail.readonly', 'allow')
    await promise1
    await promise2

    // Should have broadcast 2 resolved events
    expect(mockBroadcastReview).toHaveBeenCalledTimes(2)
    for (const call of mockBroadcastReview.mock.calls) {
      expect(call[0]).toBe('agent-1')
      expect(call[1].type).toBe('proxy_review_resolved')
      expect(call[1].decision).toBe('allow')
    }
  })

  it('double submitDecision for same id: second returns false', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    })

    const pending = manager.getPendingReviewsForAgent('agent-1')
    const reviewId = pending[0].id

    const first = manager.submitDecision(reviewId, 'allow')
    const second = manager.submitDecision(reviewId, 'deny')

    expect(first).toBe(true)
    expect(second).toBe(false)

    const result = await promise
    expect(result).toBe('allow')
  })
})
