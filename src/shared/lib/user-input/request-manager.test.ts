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

    it('upgrades a recovered synthetic when the real registration replays', () => {
      // GET-messages recovery can synthesize a payload-less stub before the
      // stream event lands (the recovery read races the container stream).
      // The real registration must replace the stub — and emit the 'created'
      // transition, because the stub's was filtered off the wire, so this is
      // the first event clients can actually render.
      const transitions: Array<{ type: string; payload: unknown }> = []
      manager.onTransition((t) => transitions.push({ type: t.type, payload: t.request.payload }))

      manager.register(secretRequest({ payload: { recovered: true } }))
      const upgraded = manager.register(
        secretRequest({ payload: { secretName: 'API_KEY', reason: 'Need it' } }),
      )

      expect((upgraded!.payload as { secretName?: string }).secretName).toBe('API_KEY')
      expect((upgraded!.payload as { recovered?: boolean }).recovered).toBeUndefined()
      expect(manager.stats.open).toBe(1)
      expect(transitions.map((t) => t.type)).toEqual(['created', 'created'])
      expect((transitions[1].payload as { secretName?: string }).secretName).toBe('API_KEY')
    })

    it('never downgrades: a recovered synthetic cannot replace a real entry', () => {
      const first = manager.register(secretRequest({ payload: { secretName: 'REAL' } }))
      const second = manager.register(secretRequest({ payload: { recovered: true } }))
      expect(second).toBe(first)
      const third = manager.register(secretRequest({ payload: { recovered: true } }))
      expect(third).toBe(first)
    })

    it('a second recovered synthetic does not re-emit over an existing one', () => {
      const transitions: string[] = []
      manager.onTransition((t) => transitions.push(t.type))
      const first = manager.register(secretRequest({ payload: { recovered: true } }))
      const second = manager.register(secretRequest({ payload: { recovered: true } }))
      expect(second).toBe(first)
      expect(transitions).toEqual(['created'])
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
      // Kind AND scope survive on the trail: a settled request stays as
      // route-bound as it was open, so the decision gate can validate it.
      expect(manager.stats.recentResolutions).toEqual([
        {
          id: 'tool-1',
          kind: 'secret',
          scope: { agentSlug: 'agent-a', sessionId: 'session-1' },
          outcome: 'answered',
        },
      ])
    })

    it('getRecentResolution returns the settled record, newest first, then nothing', () => {
      expect(manager.getRecentResolution('tool-1')).toBeUndefined()
      manager.register(secretRequest())
      manager.resolve('tool-1', 'declined')
      expect(manager.getRecentResolution('tool-1')).toEqual({
        id: 'tool-1',
        kind: 'secret',
        scope: { agentSlug: 'agent-a', sessionId: 'session-1' },
        outcome: 'declined',
      })
      // Re-registration under a different scope wins the trail on settlement.
      manager.register(secretRequest({ scope: { agentSlug: 'agent-b', sessionId: 'session-2' } }))
      manager.resolve('tool-1', 'answered')
      expect(manager.getRecentResolution('tool-1')).toMatchObject({
        scope: { agentSlug: 'agent-b', sessionId: 'session-2' },
        outcome: 'answered',
      })
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

  describe('transition listeners (unified wire feed)', () => {
    it('emits exactly one created per accepted registration and one resolved per settlement', () => {
      const transitions: Array<{ type: string; id: string; outcome?: string }> = []
      manager.onTransition((t) => transitions.push({ type: t.type, id: t.request.id, outcome: t.outcome }))

      manager.register(secretRequest())
      // First-delivery-wins duplicate must NOT re-emit.
      manager.register(secretRequest({ payload: { secretName: 'DUP' } }))
      manager.resolve('tool-1', 'answered')
      // Idempotent resolve of an unknown id must not emit.
      manager.resolve('tool-1', 'answered')

      expect(transitions).toEqual([
        { type: 'created', id: 'tool-1', outcome: undefined },
        { type: 'resolved', id: 'tool-1', outcome: 'answered' },
      ])
    })

    it('a malformed registration emits nothing', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const transitions: string[] = []
      manager.onTransition((t) => transitions.push(t.type))
      manager.register({ id: '', kind: 'secret', scope: {}, blocking: true, payload: {} } as PendingUserInputRequestInput)
      expect(transitions).toEqual([])
    })

    it('store-scoped clears emit resolved with the boundary outcome', () => {
      const outcomes: Array<{ id: string; outcome?: string }> = []
      manager.onTransition((t) => {
        if (t.type === 'resolved') outcomes.push({ id: t.request.id, outcome: t.outcome })
      })
      manager.register(secretRequest({ id: 'clear-1' }))
      manager.register(secretRequest({ id: 'clear-2' }))
      manager.clearSessionStreamRequests('session-1', 'superseded')
      expect(outcomes).toEqual([
        { id: 'clear-1', outcome: 'superseded' },
        { id: 'clear-2', outcome: 'superseded' },
      ])
    })

    it('a throwing listener is swallowed and does not break the mutation or other listeners', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const seen: string[] = []
      manager.onTransition(() => {
        throw new Error('listener boom')
      })
      manager.onTransition((t) => seen.push(t.type))
      const stored = manager.register(secretRequest())
      expect(stored).not.toBeNull()
      expect(seen).toEqual(['created'])
    })

    it('unsubscribe stops delivery', () => {
      const seen: string[] = []
      const unsubscribe = manager.onTransition((t) => seen.push(t.type))
      unsubscribe()
      manager.register(secretRequest())
      expect(seen).toEqual([])
    })
  })

  describe('getSnapshotForScope', () => {
    it("a session scope unions its own requests with the agent's agent-scoped reviews", () => {
      manager.register(secretRequest({ id: 'mine-1' }))
      manager.register(secretRequest({ id: 'other-1', scope: { agentSlug: 'agent-a', sessionId: 'session-other' } }))
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      } as PendingUserInputRequestInput)
      manager.register({
        id: 'review-b',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-b' },
        blocking: true,
        payload: { toolkit: 'github' },
      } as PendingUserInputRequestInput)

      const ids = manager.getSnapshotForScope('agent-a', 'session-1').map((r) => r.id).sort()
      expect(ids).toEqual(['mine-1', 'review-1'])
    })

    it("a session view never crosses agents — another agent's sessionId returns none of its requests", () => {
      // The sessionId reaches getSnapshotForScope from an unvalidated query
      // param behind an AgentRead gate on the AGENT only; matching on
      // sessionId alone would hand agent-a's viewer agent-b's payloads.
      manager.register(
        secretRequest({ id: 'foreign-1', scope: { agentSlug: 'agent-b', sessionId: 'session-b' } }),
      )
      manager.register({
        id: 'review-a',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      } as PendingUserInputRequestInput)

      const ids = manager.getSnapshotForScope('agent-a', 'session-b').map((r) => r.id)
      expect(ids).toEqual(['review-a'])
    })

    it('an agent scope returns everything in the agent, sessions included', () => {
      manager.register(secretRequest({ id: 'mine-1' }))
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      } as PendingUserInputRequestInput)
      const ids = manager.getSnapshotForScope('agent-a').map((r) => r.id).sort()
      expect(ids).toEqual(['mine-1', 'review-1'])
    })

    it('recovery synthetics ARE in the snapshot — a recovered wait is still a blocking wait', () => {
      // They stay off the WIRE (no renderable payload to push), but the
      // snapshot is the awaiting-status source for clients: excluding them
      // made the activity indicator read "Working…" while the server and the
      // transcript-rendered card both said awaiting input. The per-kind card
      // guards drop the payload-less entries, so no broken card renders.
      manager.register(secretRequest({ id: 'live-1' }))
      manager.register(secretRequest({ id: 'recovered-1', payload: { recovered: true } }))
      const ids = manager.getSnapshotForScope('agent-a', 'session-1').map((r) => r.id).sort()
      expect(ids).toEqual(['live-1', 'recovered-1'])
    })
  })

  describe('claimRequest / releaseClaim', () => {
    it('hands the request to the FIRST caller and null to every other', () => {
      manager.register(secretRequest())

      const first = manager.claimRequest('tool-1')
      const second = manager.claimRequest('tool-1')

      expect(first?.id).toBe('tool-1')
      // The whole point: two deciders that both read an open request would both
      // act on it. Exactly one may win.
      expect(second).toBeNull()
      expect(manager.stats.claimed).toBe(1)
    })

    it('returns null for an id that is not open', () => {
      expect(manager.claimRequest('never-existed')).toBeNull()
      manager.register(secretRequest())
      manager.resolve('tool-1', 'answered')
      expect(manager.claimRequest('tool-1')).toBeNull()
    })

    it('a claim does not hide the request from any reader', () => {
      // A claim is an in-flight decision, not a settlement — if the claimer
      // dies the human is still waiting, so the card, the snapshot and the
      // awaiting light must all still show it.
      manager.register(secretRequest())
      manager.claimRequest('tool-1')

      expect(manager.getOpenRequest('tool-1')).not.toBeNull()
      expect(manager.isSessionAwaiting('session-1', 'agent-a')).toBe(true)
      expect(manager.getSnapshotForScope('agent-a', 'session-1')).toHaveLength(1)
      expect(manager.stats.open).toBe(1)
    })

    it('releaseClaim makes it claimable again — a bailed decision must not strand it', () => {
      manager.register(secretRequest())
      manager.claimRequest('tool-1')

      manager.releaseClaim('tool-1')

      expect(manager.claimRequest('tool-1')?.id).toBe('tool-1')
    })

    it('releaseClaim on an unknown or already-settled id is a no-op', () => {
      manager.register(secretRequest())
      manager.claimRequest('tool-1')
      manager.resolve('tool-1', 'answered')

      expect(() => manager.releaseClaim('tool-1')).not.toThrow()
      expect(() => manager.releaseClaim('never-existed')).not.toThrow()
      expect(manager.stats.claimed).toBe(0)
    })

    it('resolve drops the claim, so a re-registered id does not inherit it', () => {
      // Callers release in a finally, but the success path settles instead —
      // if resolve leaked the claim, the next request to reuse the toolUseId
      // would be born undecidable.
      manager.register(secretRequest())
      manager.claimRequest('tool-1')
      manager.resolve('tool-1', 'answered')
      expect(manager.stats.claimed).toBe(0)

      manager.register(secretRequest())
      expect(manager.claimRequest('tool-1')?.id).toBe('tool-1')
    })

    it('reset clears claims', () => {
      manager.register(secretRequest())
      manager.claimRequest('tool-1')
      manager.reset()
      expect(manager.stats.claimed).toBe(0)
    })
  })

  describe('shadow diagnostics', () => {
    it('verifyStoreParity passes silently when both stores match', () => {
      manager.register(secretRequest({ id: 'stream-1' }))
      manager.verifyStoreParity({
        sessionId: 'session-1',
        context: 'test',
        streamStoreIds: ['stream-1'],
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
        }),
      ).toThrow(/shadow store mismatch/)
      expect(manager.stats.storeMismatches).toBe(1)
    })

    it('verifyReviewSettlerParity accepts settlers backed by open review entries', () => {
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      })
      manager.verifyReviewSettlerParity({ context: 'test', settlerIds: ['review-1'] })
      expect(manager.stats.storeMismatches).toBe(0)
    })

    it('verifyReviewSettlerParity accepts review entries without settlers', () => {
      // Feeders other than requestReview own no promise — an entry without a
      // settler is a legitimate pending review, not a mismatch.
      manager.register({
        id: 'review-1',
        kind: 'proxy_review',
        scope: { agentSlug: 'agent-a' },
        blocking: true,
        payload: { toolkit: 'slack' },
      })
      manager.verifyReviewSettlerParity({ context: 'test', settlerIds: [] })
      expect(manager.stats.storeMismatches).toBe(0)
    })

    it('verifyReviewSettlerParity throws under vitest on an orphaned settler', () => {
      // A settler without a registry entry is a parked proxied call no sweep
      // can ever reach.
      expect(() =>
        manager.verifyReviewSettlerParity({ context: 'test', settlerIds: ['review-orphan'] }),
      ).toThrow(/shadow store mismatch/)
      expect(manager.stats.storeMismatches).toBe(1)
    })

    it('reset wipes requests and diagnostics', () => {
      manager.register(secretRequest())
      manager.resolve('tool-1', 'answered')
      manager.reset()
      expect(manager.stats).toEqual({
        open: 0,
        claimed: 0,
        storeMismatches: 0,
        recentResolutions: [],
      })
    })
  })
})
