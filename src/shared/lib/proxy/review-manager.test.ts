import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the broadcast function
const mockBroadcastReview = vi.fn()
vi.mock('./review-broadcast', () => ({
  broadcastReview: (...args: unknown[]) => mockBroadcastReview(...args),
}))

import { ReviewManager, humanizeActionName, generateReviewDisplayText } from './review-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'

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

  it('resolveMatchingPendingByLabel resolves sibling reviews sharing the risk label', async () => {
    // Two write-labelled requests (gmail.send, gmail.compose) + one read (gmail.readonly).
    const send = manager.requestReview({
      agentSlug: 'agent-1', accountId: 'acc-1', toolkit: 'gmail', method: 'POST',
      targetPath: '/gmail/v1/users/me/messages/send', matchedScopes: ['gmail.send'], scopeDescriptions: {},
    })
    const compose = manager.requestReview({
      agentSlug: 'agent-1', accountId: 'acc-1', toolkit: 'gmail', method: 'POST',
      targetPath: '/gmail/v1/users/me/drafts', matchedScopes: ['gmail.compose'], scopeDescriptions: {},
    })
    const read = manager.requestReview({
      agentSlug: 'agent-1', accountId: 'acc-1', toolkit: 'gmail', method: 'GET',
      targetPath: '/gmail/v1/users/me/messages', matchedScopes: ['gmail.readonly'], scopeDescriptions: {},
    })
    expect(manager.getPendingReviewsForAgent('agent-1').length).toBe(3)

    // "Allow all write" → both write reviews resolve; the read review is untouched.
    manager.resolveMatchingPendingByLabel('agent-1', 'write', 'allow')
    await expect(send).resolves.toBe('allow')
    await expect(compose).resolves.toBe('allow')
    expect(manager.getPendingReviewsForAgent('agent-1').length).toBe(1)

    // does not cross agents
    manager.resolveMatchingPendingByLabel('other-agent', 'read', 'allow')
    expect(manager.getPendingReviewsForAgent('agent-1').length).toBe(1)

    // resolve the lingering read review so afterEach's rejectAll doesn't reject it
    manager.submitDecision(manager.getPendingReviewsForAgent('agent-1')[0].id, 'allow')
    await expect(read).resolves.toBe('allow')
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

  // Security: a user with `user` role on agent A must not be able to resolve
  // agent B's review by guessing/leaking B's reviewId. submitDecision must
  // refuse to mutate the review when the caller's expected agent doesn't
  // match the review's stored agent.
  it('SECURITY: submitDecision rejects when expectedAgentSlug does not match review agent', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-victim',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
    })

    const pending = manager.getPendingReviewsForAgent('agent-victim')
    const reviewId = pending[0].id

    // Attacker has role only on agent-attacker, calls
    // POST /api/agents/agent-attacker/proxy-review/<victim's reviewId>
    const success = manager.submitDecision(reviewId, 'allow', 'agent-attacker')
    expect(success).toBe(false)

    // Victim's review is still pending — not resolved
    expect(manager.getPendingReviewsForAgent('agent-victim').length).toBe(1)

    // Legit owner still resolves cleanly
    expect(manager.submitDecision(reviewId, 'deny', 'agent-victim')).toBe(true)
    expect(await promise).toBe('deny')
  })

  // Security: same shape for the omitted-arg call path. We keep the optional
  // arg backwards-compatible for internal callers (resolveMatchingPending
  // already filters by agentSlug), but any HTTP-facing caller must pass it.
  it('SECURITY: submitDecision still works when expectedAgentSlug is omitted (internal callers)', async () => {
    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    })
    const reviewId = manager.getPendingReviewsForAgent('agent-1')[0].id
    expect(manager.submitDecision(reviewId, 'allow')).toBe(true)
    expect(await promise).toBe('allow')
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

  it('abort signal cleans up orphaned review and rejects promise', async () => {
    const controller = new AbortController()

    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: ['gmail.readonly'],
      scopeDescriptions: {},
    }, controller.signal)

    // Review is pending
    expect(manager.getPendingReviewsForAgent('agent-1').length).toBe(1)

    // Simulate request abort (e.g. task stopped)
    controller.abort()

    await expect(promise).rejects.toThrow('Request aborted')

    // Review should be cleaned up
    expect(manager.getPendingReviewsForAgent('agent-1').length).toBe(0)
  })

  it('abort signal broadcasts proxy_review_resolved so UI dismisses the prompt', async () => {
    const controller = new AbortController()

    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    }, controller.signal)

    mockBroadcastReview.mockClear()
    controller.abort()
    await promise.catch(() => {})

    expect(mockBroadcastReview).toHaveBeenCalledOnce()
    const [agentSlug, event] = mockBroadcastReview.mock.calls[0]
    expect(agentSlug).toBe('agent-1')
    expect(event.type).toBe('proxy_review_resolved')
    expect(event.decision).toBe('deny')
  })

  describe('humanizeActionName', () => {
    it('converts snake_case verb to gerund', () => {
      expect(humanizeActionName('list_meetings')).toBe('listing meetings')
      expect(humanizeActionName('search_contacts')).toBe('searching contacts')
    })

    it('doubles consonant for short verbs', () => {
      expect(humanizeActionName('get_user')).toBe('getting user')
      expect(humanizeActionName('set_value')).toBe('setting value')
      expect(humanizeActionName('run_task')).toBe('running task')
    })

    it('drops trailing e before -ing', () => {
      expect(humanizeActionName('create_document')).toBe('creating document')
      expect(humanizeActionName('delete_file')).toBe('deleting file')
    })

    it('handles kebab-case', () => {
      expect(humanizeActionName('send-message')).toBe('sending message')
    })

    it('handles empty string gracefully', () => {
      expect(humanizeActionName('')).toBe('action')
    })

    it('handles single word', () => {
      expect(humanizeActionName('list')).toBe('listing')
    })
  })

  describe('generateReviewDisplayText', () => {
    it('uses scope description when available', () => {
      const result = generateReviewDisplayText('gmail', 'GET', '/path', {
        'gmail.readonly': 'Read your email',
      })
      expect(result).toBe('Allow read your email?')
    })

    it('returns scope description as-is if it already ends with ?', () => {
      const result = generateReviewDisplayText('gmail', 'GET', '/path', {
        'gmail.readonly': 'Read your email?',
      })
      expect(result).toBe('Read your email?')
    })

    it('does not produce "Allow allow..." for descriptions starting with Allow', () => {
      const result = generateReviewDisplayText('gmail', 'GET', '/path', {
        'gmail.readonly': 'Allow reading your email',
      })
      expect(result).toBe('Allow reading your email?')
      expect(result).not.toMatch(/Allow allow/i)
    })

    it('handles MCP tool call paths', () => {
      const result = generateReviewDisplayText('slack', 'POST', 'tools/call: send_message', {})
      expect(result).toBe('Allow sending message via Slack?')
    })

    it('falls back to generic text when no scope descriptions or MCP path', () => {
      const result = generateReviewDisplayText('gmail', 'GET', '/api/endpoint', {})
      expect(result).toBe('Allow GET request to Gmail?')
    })

    it('prefers endpoint description over scope description', () => {
      // The headline must describe the immediate action, not the broad scope
      // grant — otherwise approving a profile read would surface "Read,
      // compose, send, and permanently delete all your email" as the headline.
      const result = generateReviewDisplayText(
        'gmail',
        'GET',
        '/gmail/v1/users/me/profile',
        {
          'gmail.readonly': 'View your email messages and settings',
          'gmail.full': 'Read, compose, send, and permanently delete all your email',
        },
        "Gets the current user's Gmail profile.",
      )
      expect(result).toBe("Allow gets the current user's Gmail profile.?")
    })

    it('falls back to scope description when endpointDescription is undefined', () => {
      const result = generateReviewDisplayText(
        'gmail',
        'GET',
        '/path',
        { 'gmail.readonly': 'Read your email' },
        undefined,
      )
      expect(result).toBe('Allow read your email?')
    })
  })

  it('abort after submitDecision is a no-op (review already resolved)', async () => {
    const controller = new AbortController()

    const promise = manager.requestReview({
      agentSlug: 'agent-1',
      accountId: 'acc-1',
      toolkit: 'gmail',
      method: 'GET',
      targetPath: '/path',
      matchedScopes: [],
      scopeDescriptions: {},
    }, controller.signal)

    const pending = manager.getPendingReviewsForAgent('agent-1')
    manager.submitDecision(pending[0].id, 'allow')
    const result = await promise
    expect(result).toBe('allow')

    // Aborting after resolution should not broadcast a spurious event
    mockBroadcastReview.mockClear()
    controller.abort()
    expect(manager.getPendingReviewsForAgent('agent-1').length).toBe(0)
    expect(mockBroadcastReview).not.toHaveBeenCalled()
  })

  describe('requestXAgentReview', () => {
    it('broadcasts xAgent payload + scope=invoke:target for invoke ops', async () => {
      const promise = manager.requestXAgentReview('caller', 'target', 'Target Agent', 'invoke', 'hello there')

      expect(mockBroadcastReview).toHaveBeenCalledWith(
        'caller',
        expect.objectContaining({
          type: 'proxy_review_request',
          toolkit: 'agents',
          method: 'invoke',
          targetPath: 'agents:invoke:target',
          matchedScopes: ['invoke:target'],
          xAgent: {
            targetAgentSlug: 'target',
            targetAgentName: 'Target Agent',
            operation: 'invoke',
            preview: 'hello there',
          },
        }),
      )

      const pending = manager.getPendingReviewsForAgent('caller')
      expect(pending).toHaveLength(1)
      expect(pending[0].xAgent?.operation).toBe('invoke')
      expect(pending[0].accountId).toBe('target')

      manager.submitDecision(pending[0].id, 'allow')
      const result = await promise
      expect(result).toBe('allow')
    })

    it('uses scope=list for list operations (no per-target row)', () => {
      // Swallow rejection — afterEach calls rejectAll which rejects unresolved reviews
      manager.requestXAgentReview('caller', '', 'all agents', 'list').catch(() => {})
      expect(mockBroadcastReview).toHaveBeenCalledWith(
        'caller',
        expect.objectContaining({
          method: 'list',
          matchedScopes: ['list'],
          xAgent: expect.objectContaining({ operation: 'list' }),
        }),
      )
    })

    it('uses scope=create for create operations', () => {
      manager.requestXAgentReview('caller', '', 'New Helper', 'create', 'New Helper').catch(() => {})
      expect(mockBroadcastReview).toHaveBeenCalledWith(
        'caller',
        expect.objectContaining({
          method: 'create',
          matchedScopes: ['create'],
          xAgent: expect.objectContaining({ operation: 'create', preview: 'New Helper' }),
        }),
      )
    })

    it('deny resolves with "deny"', async () => {
      const promise = manager.requestXAgentReview('caller', 'target', 'Target', 'read')
      const pending = manager.getPendingReviewsForAgent('caller')
      manager.submitDecision(pending[0].id, 'deny')
      expect(await promise).toBe('deny')
    })

    it('non-x-agent reviews do NOT carry xAgent in the broadcast', () => {
      manager.requestReview({
        agentSlug: 'agent-1',
        accountId: 'acc-1',
        toolkit: 'gmail',
        method: 'GET',
        targetPath: '/v1/messages',
        matchedScopes: ['readonly'],
        scopeDescriptions: {},
      }).catch(() => {})
      const call = mockBroadcastReview.mock.calls[0]
      expect(call[1]).not.toHaveProperty('xAgent')
    })
  })
})

describe('ReviewManager shadow registry write-through (Phase 2)', () => {
  let manager: ReviewManager

  const DETAILS = {
    agentSlug: 'shadow-agent',
    accountId: 'acc-1',
    toolkit: 'gmail',
    method: 'GET',
    targetPath: '/v1/messages',
    matchedScopes: ['gmail.readonly'],
    scopeDescriptions: { 'gmail.readonly': 'Read email' },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    manager = new ReviewManager()
    userInputRequestManager.reset()
  })

  afterEach(() => {
    manager.rejectAll()
    vi.useRealTimers()
  })

  it('requestReview registers an agent-scoped proxy_review envelope', () => {
    manager.requestReview(DETAILS).catch(() => {})
    const open = userInputRequestManager.getAgentScopedRequests('shadow-agent')
    expect(open).toHaveLength(1)
    expect(open[0].kind).toBe('proxy_review')
    expect(open[0].scope).toEqual({ agentSlug: 'shadow-agent' })
    expect(open[0].blocking).toBe(true)
    // The agent-scoped entry drives the derived projection for every session
    // of the agent — the seam that replaces registerAwaitingBlockerSource.
    expect(userInputRequestManager.isAgentAwaiting('shadow-agent')).toBe(true)
    expect(userInputRequestManager.isSessionAwaiting('any-session', 'shadow-agent')).toBe(true)
  })

  it('an x-agent review registers as x_agent_review', () => {
    manager
      .requestXAgentReview('shadow-agent', 'target-agent', 'Target', 'invoke', 'hi')
      .catch(() => {})
    const open = userInputRequestManager.getAgentScopedRequests('shadow-agent')
    expect(open).toHaveLength(1)
    expect(open[0].kind).toBe('x_agent_review')
  })

  it('submitDecision settles the envelope with the decision outcome', async () => {
    const promise = manager.requestReview(DETAILS)
    const reviewId = manager.getPendingReviewsForAgent('shadow-agent')[0].id

    manager.submitDecision(reviewId, 'allow')
    await promise
    expect(userInputRequestManager.getAgentScopedRequests('shadow-agent')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
      id: reviewId,
      kind: 'proxy_review',
      outcome: 'answered',
    })
    expect(userInputRequestManager.isAgentAwaiting('shadow-agent')).toBe(false)
  })

  it('the 5-minute auto-deny settles the envelope as timeout', async () => {
    const promise = manager.requestReview(DETAILS)
    const reviewId = manager.getPendingReviewsForAgent('shadow-agent')[0].id

    vi.advanceTimersByTime(5 * 60 * 1000)
    await expect(promise).rejects.toThrow('Review timeout')
    expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
      id: reviewId,
      kind: 'proxy_review',
      outcome: 'timeout',
    })
    expect(userInputRequestManager.getAgentScopedRequests('shadow-agent')).toHaveLength(0)
  })

  it('an aborted request settles the envelope as cancelled', async () => {
    const controller = new AbortController()
    const promise = manager.requestReview(DETAILS, controller.signal)
    const reviewId = manager.getPendingReviewsForAgent('shadow-agent')[0].id

    controller.abort()
    await expect(promise).rejects.toThrow('Request aborted')
    expect(userInputRequestManager.stats.recentResolutions.at(-1)).toEqual({
      id: reviewId,
      kind: 'proxy_review',
      outcome: 'cancelled',
    })
  })

  it('denyAllForAgent settles every envelope of the agent as declined', async () => {
    const p1 = manager.requestReview(DETAILS)
    const p2 = manager.requestReview({ ...DETAILS, targetPath: '/v1/other' })
    expect(userInputRequestManager.getAgentScopedRequests('shadow-agent')).toHaveLength(2)

    manager.denyAllForAgent('shadow-agent')
    await Promise.all([p1, p2])
    expect(userInputRequestManager.getAgentScopedRequests('shadow-agent')).toHaveLength(0)
    expect(
      userInputRequestManager.stats.recentResolutions.slice(-2).map((r) => r.outcome)
    ).toEqual(['declined', 'declined'])
  })

  it('resolveMatchingPending sweeps matching envelopes with the decision outcome', async () => {
    const promise = manager.requestReview(DETAILS)
    manager.resolveMatchingPending('shadow-agent', 'gmail.readonly', 'allow')
    await promise
    expect(userInputRequestManager.getAgentScopedRequests('shadow-agent')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('answered')
  })

  it('rejectAll settles every envelope as cancelled', async () => {
    const promise = manager.requestReview(DETAILS)
    manager.rejectAll()
    await expect(promise).rejects.toThrow('Review timeout')
    expect(userInputRequestManager.getAgentScopedRequests('shadow-agent')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('cancelled')
  })
})
