/**
 * Proxy review must mark the agent's active session(s) awaiting so
 * computeActivity / the chat tick stop painting Working… while Allow/Deny
 * is parked — and must clear on every termination path without wiping a
 * concurrent secret/question wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachLiveSessionsHarness } from '@shared/lib/agent-actor/testing/live-sessions-harness'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import { ReviewManager } from './review-manager'
import { releaseSessionState } from '@shared/lib/agent-actor/agent-state'

// The actors' in-memory state (requests, reviews, live sessions), which the
// review manager routes to; the sessions' global feed is the recording host.
const live = attachLiveSessionsHarness()

const SESSION_ID = 'proxy-review-awaiting-session'
const AGENT_SLUG = 'proxy-review-awaiting-agent'
const sessions = () => live.sessions(AGENT_SLUG)

function reviewDetails() {
  return {
    agentSlug: AGENT_SLUG,
    accountId: 'acct-1',
    toolkit: 'gmail',
    method: 'POST',
    targetPath: '/gmail/v1/users/me/messages/send',
    matchedScopes: ['GMAIL_SEND_EMAIL'],
    scopeDescriptions: { GMAIL_SEND_EMAIL: 'Send an email' },
  }
}

describe('proxy review session awaiting', () => {
  let manager: ReviewManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new ReviewManager()
    manager.attachAgents(live.agents.pick((state) => state.reviews))
    sessions().markActive(SESSION_ID)
  })

  afterEach(() => {
    manager.rejectAll()
    live.reset()
    vi.useRealTimers()
  })

  it('marks activity awaiting while a review is pending', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(manager.getPendingReviewsForAgent(AGENT_SLUG)).toHaveLength(1)
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    expect(sessions().activity(SESSION_ID)).toBe('awaiting')

    const id = manager.getPendingReviewsForAgent(AGENT_SLUG)[0].id
    manager.submitDecision(AGENT_SLUG, id, 'deny')
    await promise.catch(() => {})
  })

  it('clears awaiting on allow when nothing else is waiting', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(sessions().activity(SESSION_ID)).toBe('awaiting')
    const id = manager.getPendingReviewsForAgent(AGENT_SLUG)[0].id
    manager.submitDecision(AGENT_SLUG, id, 'allow')
    await promise
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    expect(sessions().activity(SESSION_ID)).toBe('working')
  })

  it('clears awaiting on timeout and announces the settlement', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(sessions().activity(SESSION_ID)).toBe('awaiting')

    vi.advanceTimersByTime(5 * 60 * 1000)
    await expect(promise).rejects.toThrow('Review timeout')
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)

    const resolved = live.host
      .sent('global')
      .filter((e) => e.type === 'user_request_resolved' && e.outcome === 'timeout')
    expect(resolved.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps awaiting when a second review is still pending after the first resolves', async () => {
    const p1 = manager.requestReview(reviewDetails())
    const p2 = manager.requestReview(reviewDetails())
    const [r1, r2] = manager.getPendingReviewsForAgent(AGENT_SLUG)
    manager.submitDecision(AGENT_SLUG, r1.id, 'allow')
    await p1
    expect(sessions().activity(SESSION_ID)).toBe('awaiting')
    manager.submitDecision(AGENT_SLUG, r2.id, 'deny')
    await p2.catch(() => {})
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('does not clear awaiting when a blocking input request is still open', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

    // Park a secret request the way the session's tool calls do — awaiting
    // derives from the registry entry.
    userInputRequestManager.register({
      id: 'secret-1',
      kind: 'secret',
      scope: { agentSlug: AGENT_SLUG, sessionId: SESSION_ID },
      blocking: true,
      autoApproved: false,
      payload: { secretName: 'API_KEY' },
    })

    const id = manager.getPendingReviewsForAgent(AGENT_SLUG)[0].id
    manager.submitDecision(AGENT_SLUG, id, 'deny')
    await promise.catch(() => {})

    expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
    expect(sessions().activity(SESSION_ID)).toBe('awaiting')

    userInputRequestManager.resolve(AGENT_SLUG, 'secret-1', 'cancelled')
  })

  describe('when the call names its session', () => {
    const OTHER_SESSION_ID = 'proxy-review-awaiting-other-session'

    beforeEach(() => {
      sessions().markActive(OTHER_SESSION_ID)
    })

    it('marks only that session awaiting', async () => {
      const promise = manager.requestReview({ ...reviewDetails(), callerSessionId: SESSION_ID })

      expect(sessions().activity(SESSION_ID)).toBe('awaiting')
      expect(sessions().activity(OTHER_SESSION_ID)).toBe('working')

      const [review] = manager.getPendingReviewsForAgent(AGENT_SLUG)
      expect(manager.submitDecision(AGENT_SLUG, review.id, 'allow')).toBe(true)
      await expect(promise).resolves.toEqual({ decision: 'allow' })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('marks every session awaiting when that session is not running', async () => {
      const promise = manager.requestReview({ ...reviewDetails(), callerSessionId: 'session-that-ended' })

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)
      expect(sessions().isAwaitingInput(OTHER_SESSION_ID)).toBe(true)

      const [review] = manager.getPendingReviewsForAgent(AGENT_SLUG)
      manager.submitDecision(AGENT_SLUG, review.id, 'deny')
      await expect(promise).resolves.toMatchObject({ decision: 'deny' })
    })

    it('"allow all" for a scope settles a review shown in one session', async () => {
      const promise = manager.requestReview({ ...reviewDetails(), callerSessionId: SESSION_ID })

      manager.resolveMatchingPending(AGENT_SLUG, 'GMAIL_SEND_EMAIL', 'allow')

      await expect(promise).resolves.toEqual({ decision: 'allow' })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it("stopping another session leaves this session's review open", async () => {
      const promise = manager.requestReview({ ...reviewDetails(), callerSessionId: SESSION_ID })

      manager.denyAllForAgent(AGENT_SLUG, OTHER_SESSION_ID)
      expect(manager.getPendingReviewsForAgent(AGENT_SLUG)).toHaveLength(1)

      manager.denyAllForAgent(AGENT_SLUG, SESSION_ID)
      await expect(promise).resolves.toMatchObject({ decision: 'deny' })
    })

    it('keeps the session awaiting after its turn ends while its own review is open', async () => {
      const promise = manager.requestReview({ ...reviewDetails(), callerSessionId: SESSION_ID })

      sessions().markIdle(SESSION_ID)
      expect(sessions().isActive(SESSION_ID)).toBe(false)
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(true)

      const [review] = manager.getPendingReviewsForAgent(AGENT_SLUG)
      manager.submitDecision(AGENT_SLUG, review.id, 'allow')
      await expect(promise).resolves.toEqual({ decision: 'allow' })
      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
    })

    it('an idle session is not awaiting on an agent-wide review', async () => {
      sessions().markIdle(SESSION_ID)
      const promise = manager.requestReview(reviewDetails())

      expect(sessions().isAwaitingInput(SESSION_ID)).toBe(false)
      expect(sessions().isAwaitingInput(OTHER_SESSION_ID)).toBe(true)

      const [review] = manager.getPendingReviewsForAgent(AGENT_SLUG)
      manager.submitDecision(AGENT_SLUG, review.id, 'deny')
      await expect(promise).resolves.toMatchObject({ decision: 'deny' })
    })

    it('deleting the session denies the call parked on its review', async () => {
      const promise = manager.requestReview({ ...reviewDetails(), callerSessionId: SESSION_ID })
      const state = live.agents.get(AGENT_SLUG)

      releaseSessionState(state, SESSION_ID)
      sessions().unsubscribe(SESSION_ID)

      await expect(promise).resolves.toMatchObject({ decision: 'deny' })
      expect(state.reviews.settlerIds()).toEqual([])
      expect(manager.getPendingReviewsForAgent(AGENT_SLUG)).toHaveLength(0)
    })
  })
})
