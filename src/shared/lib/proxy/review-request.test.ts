/**
 * A parked review as the host waits on it (`awaitReview`): the outcome comes
 * back as data, a sweep that changed the policy is decided again on the host,
 * and an aborted request withdraws its card. Over the agents' real reviews in
 * memory, through the router the way the proxy reaches them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewManager } from './review-manager'
import type { ReviewDetails } from './review-display'
import { attachInMemoryAgentState, type InMemoryAgentStateDirectory } from '@shared/lib/agent-actor/testing/in-memory-agent-state'

const details: ReviewDetails = {
  agentSlug: 'agent',
  accountId: 'acc',
  toolkit: 'gmail',
  method: 'POST',
  targetPath: '/send',
  matchedScopes: ['gmail.send'],
  scopeDescriptions: {},
}

let agents: InMemoryAgentStateDirectory
let manager: ReviewManager
const pending = () => manager.getPendingReviewsForAgent('agent')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  manager = new ReviewManager()
  agents = attachInMemoryAgentState()
  manager.attachAgents(agents.pick((state) => state.reviews))
})

afterEach(() => {
  manager.rejectAll()
  agents.reset()
  vi.useRealTimers()
})

describe('awaitReview', () => {
  it('decides a swept review again on the host and settles it without the person', async () => {
    const reevaluate = vi.fn(async () => 'allow' as const)
    const decision = manager.requestReview(details, undefined, { reevaluate })
    expect(pending()).toHaveLength(1)

    manager.resolveMatchingPending('agent', 'gmail.send', 'allow')

    await expect(decision).resolves.toBe('allow')
    expect(reevaluate).toHaveBeenCalledOnce()
    expect(pending()).toEqual([])
  })

  it('leaves a swept review the new policy still holds for the person', async () => {
    const decision = manager.requestReview(details, undefined, { reevaluate: async () => 'review' })
    const [card] = pending()

    manager.resolveMatchingPending('agent', 'gmail.send', 'allow')
    await flush()
    expect(pending().map((review) => review.id)).toEqual([card.id])

    expect(manager.submitDecision(card.id, 'deny', 'agent')).toBe(true)
    await expect(decision).resolves.toBe('deny')
  })

  it('lets the person\'s decision win when it lands while the host rechecks', async () => {
    let finishRecheck!: (outcome: 'allow') => void
    const decision = manager.requestReview(details, undefined, {
      reevaluate: () => new Promise((resolve) => { finishRecheck = resolve }),
    })
    const [card] = pending()

    manager.resolveMatchingPending('agent', 'gmail.send', 'allow')
    await flush()
    expect(manager.submitDecision(card.id, 'deny', 'agent')).toBe(true)
    finishRecheck('allow')

    await expect(decision).resolves.toBe('deny')
    expect(pending()).toEqual([])
  })

  it('withdraws the card of an aborted request', async () => {
    const controller = new AbortController()
    const decision = manager.requestReview(details, controller.signal)
    expect(pending()).toHaveLength(1)

    controller.abort()

    await expect(decision).rejects.toThrow('Request aborted')
    expect(pending()).toEqual([])
  })

  it('raises no card for a request already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(manager.requestReview(details, controller.signal)).rejects.toThrow('Request aborted')
    expect(pending()).toEqual([])
  })

  it('reports a review nobody decided in time as a timeout', async () => {
    vi.useFakeTimers()
    const decision = manager.requestReview(details)
    const outcome = expect(decision).rejects.toThrow('Review timeout')
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await outcome
    expect(pending()).toEqual([])
  })

  it('releases a swept review whose caller does not recheck', async () => {
    const decision = manager.requestReview(details)
    manager.resolveMatchingPending('agent', 'gmail.send', 'allow')
    await expect(decision).resolves.toBe('allow')
  })
})
