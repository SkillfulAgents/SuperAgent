/**
 * Proxy review must mark the agent's active session(s) awaiting so
 * computeActivity / the chat tick stop painting Working… while Allow/Deny
 * is parked — and must clear on every termination path without wiping a
 * concurrent secret/question wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messagePersister } from '@shared/lib/container/message-persister'
import { ReviewManager } from './review-manager'

const SESSION_ID = 'proxy-review-awaiting-session'
const AGENT_SLUG = 'proxy-review-awaiting-agent'

type StreamState = {
  isAwaitingInput: boolean
  pendingInputRequests: Map<string, { type: string; toolUseId: string; autoApproved?: boolean }>
}

function streamState(): StreamState | undefined {
  return (messagePersister as unknown as { streamingStates: Map<string, StreamState> })
    .streamingStates.get(SESSION_ID)
}

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
    messagePersister.markSessionActive(SESSION_ID, AGENT_SLUG)
  })

  afterEach(() => {
    manager.rejectAll()
    vi.useRealTimers()
  })

  it('marks activity awaiting while a review is pending', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(manager.getPendingReviewsForAgent(AGENT_SLUG)).toHaveLength(1)
    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    expect(messagePersister.getSessionActivity(SESSION_ID)).toBe('awaiting')

    const id = manager.getPendingReviewsForAgent(AGENT_SLUG)[0].id
    manager.submitDecision(id, 'deny', AGENT_SLUG)
    await promise.catch(() => {})
  })

  it('clears awaiting on allow when nothing else is waiting', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(messagePersister.getSessionActivity(SESSION_ID)).toBe('awaiting')
    const id = manager.getPendingReviewsForAgent(AGENT_SLUG)[0].id
    manager.submitDecision(id, 'allow', AGENT_SLUG)
    await promise
    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
    expect(messagePersister.getSessionActivity(SESSION_ID)).toBe('working')
  })

  it('clears awaiting on timeout and broadcasts proxy_review_resolved', async () => {
    const globalEvents: Array<Record<string, unknown>> = []
    const unsub = messagePersister.addGlobalNotificationClient((e) => {
      globalEvents.push(e as Record<string, unknown>)
    })

    const promise = manager.requestReview(reviewDetails())
    expect(messagePersister.getSessionActivity(SESSION_ID)).toBe('awaiting')

    vi.advanceTimersByTime(5 * 60 * 1000)
    await expect(promise).rejects.toThrow('Review timeout')
    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)

    const resolved = globalEvents.filter(
      (e) =>
        e.type === 'session_awaiting_input' &&
        (e.review as { type?: string } | undefined)?.type === 'proxy_review_resolved',
    )
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    unsub()
  })

  it('keeps awaiting when a second review is still pending after the first resolves', async () => {
    const p1 = manager.requestReview(reviewDetails())
    const p2 = manager.requestReview(reviewDetails())
    const [r1, r2] = manager.getPendingReviewsForAgent(AGENT_SLUG)
    manager.submitDecision(r1.id, 'allow', AGENT_SLUG)
    await p1
    expect(messagePersister.getSessionActivity(SESSION_ID)).toBe('awaiting')
    manager.submitDecision(r2.id, 'deny', AGENT_SLUG)
    await p2.catch(() => {})
    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(false)
  })

  it('does not clear awaiting when a blocking input request is still open', async () => {
    const promise = manager.requestReview(reviewDetails())
    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)

    const state = streamState()
    state?.pendingInputRequests.set('secret-1', {
      type: 'request_secret',
      toolUseId: 'secret-1',
    })

    const id = manager.getPendingReviewsForAgent(AGENT_SLUG)[0].id
    manager.submitDecision(id, 'deny', AGENT_SLUG)
    await promise.catch(() => {})

    expect(messagePersister.isSessionAwaitingInput(SESSION_ID)).toBe(true)
    expect(messagePersister.getSessionActivity(SESSION_ID)).toBe('awaiting')
  })
})
