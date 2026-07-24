import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UserInputRequestManager } from './request-manager'
import type { PendingUserInputRequestInput } from './request-schema'

function secretRequest(overrides: Partial<PendingUserInputRequestInput> = {}): PendingUserInputRequestInput {
  return {
    id: 'tool-1',
    kind: 'secret',
    scope: { agentSlug: 'agent-a', sessionId: 'session-1' },
    blocking: true,
    payload: { secretName: 'API_KEY', reason: 'Need it' },
    ...overrides,
  } as PendingUserInputRequestInput
}

describe('UserInputRequestManager', () => {
  let manager: UserInputRequestManager

  beforeEach(() => {
    manager = new UserInputRequestManager()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('register', () => {
    it('parses and stores a request, defaulting autoApproved to false', () => {
      const stored = manager.register(secretRequest())
      expect(stored).not.toBeNull()
      expect(stored!.kind).toBe('secret')
      expect(stored!.autoApproved).toBe(false)
      expect(manager.getOpenRequestsForSession('session-1')).toHaveLength(1)
    })

    it('is first-delivery-wins: re-registering an open id returns the original unchanged', () => {
      const first = manager.register(secretRequest({ payload: { secretName: 'FIRST' } }))
      const second = manager.register(secretRequest({ payload: { secretName: 'SECOND' } }))
      expect(second).toBe(first)
      const open = manager.getOpenRequestsForSession('session-1')
      expect(open).toHaveLength(1)
      expect((open[0].payload as { secretName?: string }).secretName).toBe('FIRST')
    })

    it('drops a malformed envelope without throwing (shadow mode must never break delivery)', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      const stored = manager.register({
        id: '',
        kind: 'secret',
        scope: {},
        blocking: true,
        payload: {},
      } as PendingUserInputRequestInput)
      expect(stored).toBeNull()
      expect(manager.stats.open).toBe(0)
      expect(consoleError).toHaveBeenCalledTimes(1)
    })

    it('tolerates malformed payload fields instead of rejecting the request', () => {
      const stored = manager.register(
        secretRequest({ payload: { secretName: 42, reason: { nested: true } } }),
      )
      expect(stored).not.toBeNull()
      expect((stored!.payload as { secretName?: string }).secretName).toBeUndefined()
    })
  })

  describe('resolve', () => {
    it('removes the request and records the outcome', () => {
      manager.register(secretRequest())
      const resolved = manager.resolve('tool-1', 'answered')
      expect(resolved?.kind).toBe('secret')
      expect(manager.stats.open).toBe(0)
      expect(manager.stats.recentResolutions).toEqual([
        { id: 'tool-1', kind: 'secret', outcome: 'answered' },
      ])
    })

    it('is idempotent: unknown ids are a no-op returning null', () => {
      expect(manager.resolve('never-registered', 'answered')).toBeNull()
      manager.register(secretRequest())
      manager.resolve('tool-1', 'answered')
      expect(manager.resolve('tool-1', 'answered')).toBeNull()
      expect(manager.stats.recentResolutions).toHaveLength(1)
    })
  })

  describe('resolveIfInStore', () => {
    it('refuses to settle a request that lives on a different store', () => {
      manager.register({
        id: 'cu-1',
        kind: 'computer_use',
        scope: { agentSlug: 'agent-a', sessionId: 'session-1' },
        blocking: true,
        payload: { method: 'click' },
      })
      // A stray main-path tool_result deletes blindly from the stream store —
      // it must not evict the computer-use entry its own store still holds.
      expect(manager.resolveIfInStore('cu-1', 'stream', 'answered')).toBeNull()
      expect(manager.stats.open).toBe(1)
      expect(manager.resolveIfInStore('cu-1', 'computer_use', 'answered')).not.toBeNull()
      expect(manager.stats.open).toBe(0)
    })
  })

  describe('store-scoped clears', () => {
    beforeEach(() => {
      manager.register(secretRequest({ id: 'stream-1' }))
      manager.register({
        id: 'cu-1',
        kind: 'computer_use',
        scope: { agentSlug: 'agent-a', sessionId: 'session-1' },
        blocking: true,
        payload: { method: 'click' },
      })
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      })
      manager.register(secretRequest({ id: 'other-session', scope: { agentSlug: 'agent-a', sessionId: 'session-2' } }))
    })

    it('clearSessionStreamRequests wipes only the session\'s stream store (turn-boundary mirror)', () => {
      manager.clearSessionStreamRequests('session-1', 'cancelled')
      expect(manager.getOpenRequestsForSession('session-1').map((r) => r.id)).toEqual(['cu-1'])
      expect(manager.getOpenRequestsForSession('session-2')).toHaveLength(1)
      expect(manager.getAgentScopedRequests('agent-a')).toHaveLength(1)
    })

    it('dropSessionRequests removes every session-scoped entry but leaves agent-scoped reviews', () => {
      manager.dropSessionRequests('session-1')
      expect(manager.getOpenRequestsForSession('session-1')).toHaveLength(0)
      expect(manager.getOpenRequestsForSession('session-2')).toHaveLength(1)
      expect(manager.getAgentScopedRequests('agent-a')).toHaveLength(1)
    })
  })

  describe('awaiting projection', () => {
    it('a session-scoped blocking request makes the session awaiting', () => {
      manager.register(secretRequest())
      expect(manager.isSessionAwaiting('session-1')).toBe(true)
      expect(manager.isSessionAwaiting('session-2')).toBe(false)
      manager.resolve('tool-1', 'answered')
      expect(manager.isSessionAwaiting('session-1')).toBe(false)
    })

    it('auto-approved requests never count as real waits', () => {
      manager.register(
        secretRequest({ id: 'auto-1', kind: 'script_run', autoApproved: true, payload: {} }),
      )
      expect(manager.isSessionAwaiting('session-1')).toBe(false)
      expect(manager.isAgentAwaiting('agent-a')).toBe(false)
    })

    it('an agent-scoped review blocks every session of that agent', () => {
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      })
      expect(manager.isSessionAwaiting('any-session-of-a', 'agent-a')).toBe(true)
      expect(manager.isSessionAwaiting('any-session-of-b', 'agent-b')).toBe(false)
      expect(manager.isAgentAwaiting('agent-a')).toBe(true)
    })
  })

  describe('shadow diagnostics', () => {
    it('verifyStoreParity passes silently when both stores match', () => {
      manager.register(secretRequest({ id: 'stream-1' }))
      manager.verifyStoreParity({
        sessionId: 'session-1',
        context: 'test',
        streamStoreIds: ['stream-1'],
        computerUseStoreIds: [],
      })
      expect(manager.stats.storeMismatches).toBe(0)
    })

    it('verifyStoreParity throws under vitest on a mismatch and counts it', () => {
      manager.register(secretRequest({ id: 'stream-1' }))
      expect(() =>
        manager.verifyStoreParity({
          sessionId: 'session-1',
          context: 'test',
          streamStoreIds: ['stream-1', 'stream-2'],
          computerUseStoreIds: [],
        }),
      ).toThrow(/shadow store mismatch/)
      expect(manager.stats.storeMismatches).toBe(1)
    })

    it('verifyReviewStoreParity compares only agent-scoped review entries', () => {
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      })
      // Session-scoped stream noise for the same agent must not leak into the
      // review comparison.
      manager.register(secretRequest())

      manager.verifyReviewStoreParity({
        agentSlug: 'agent-a',
        context: 'test',
        reviewStoreIds: ['review-1'],
      })
      expect(manager.stats.storeMismatches).toBe(0)
    })

    it('verifyReviewStoreParity throws under vitest when a review write-through was missed', () => {
      // ReviewManager holds a review the registry never saw.
      expect(() =>
        manager.verifyReviewStoreParity({
          agentSlug: 'agent-a',
          context: 'test',
          reviewStoreIds: ['review-orphan'],
        }),
      ).toThrow(/shadow store mismatch/)
      expect(manager.stats.storeMismatches).toBe(1)
    })

    it('compareAwaitingProjection counts divergence and warns once per episode', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      manager.register(secretRequest())

      // Bit says false while a real wait is open: diverged. Two checks in the
      // same episode → two counts, ONE warn.
      const diverged = {
        sessionId: 'session-1',
        context: 'test',
        agentSlug: 'agent-a',
        isAwaitingInput: false,
      }
      manager.compareAwaitingProjection(diverged)
      manager.compareAwaitingProjection(diverged)
      expect(manager.stats.awaitingDivergences).toBe(2)
      expect(consoleWarn).toHaveBeenCalledTimes(1)

      // Convergence closes the episode; the next divergence warns again.
      manager.compareAwaitingProjection({ ...diverged, isAwaitingInput: true })
      manager.compareAwaitingProjection(diverged)
      expect(consoleWarn).toHaveBeenCalledTimes(2)
    })

    it('reset wipes requests and diagnostics', () => {
      manager.register(secretRequest())
      manager.resolve('tool-1', 'answered')
      manager.reset()
      expect(manager.stats).toEqual({
        open: 0,
        storeMismatches: 0,
        awaitingDivergences: 0,
        recentResolutions: [],
      })
    })
  })
})
