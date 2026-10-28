import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import {
  ACCOUNT_REAUTH_TIMEOUT_MS,
  AccountReauthManager,
} from './account-reauth-manager'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import {
  attachInMemoryAgentState,
  type InMemoryAgentStateDirectory,
} from '@shared/lib/agent-actor/testing/in-memory-agent-state'
import { releaseSessionState, settleStoppedSession } from '@shared/lib/agent-actor/agent-state'

const DETAILS = {
  agentSlug: 'agent-1',
  accountId: 'account-1',
  toolkit: 'gmail',
  accountStatus: 'expired' as const,
}

describe('AccountReauthManager', () => {
  let manager: AccountReauthManager
  let agents: InMemoryAgentStateDirectory
  let syncAwaiting: Map<string, MockInstance<() => void>>
  const runningSessions = new Set<string>()

  beforeEach(() => {
    vi.useFakeTimers()
    // The waits live on the agents' actors; the manager under test routes to
    // them. Build the actors' stores in memory, attached the way the registry
    // attaches the real handles.
    agents = attachInMemoryAgentState()
    // A card opening or closing has the agent's sessions recompute their
    // waiting state: observed here, with no session to recompute.
    syncAwaiting = new Map(
      ['agent-1', 'agent-2'].map((slug) => [
        slug,
        vi.spyOn(agents.get(slug).sessions, 'syncAwaiting').mockImplementation(() => {}),
      ]),
    )
    // Which sessions run a turn decides where a card that names its session shows.
    runningSessions.clear()
    for (const slug of ['agent-1', 'agent-2']) {
      vi.spyOn(agents.get(slug).sessions, 'isActive').mockImplementation((sessionId) => runningSessions.has(sessionId))
    }
    manager = new AccountReauthManager()
    manager.attachAgents(agents.pick((state) => state.accountReauth))
    userInputRequestManager.reset()
  })

  afterEach(() => {
    agents.reset()
    vi.useRealTimers()
  })

  it('registers an agent-scoped envelope with the proxy request id', () => {
    const promise = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(request).toMatchObject({
      kind: 'account_reauth_required',
      blocking: true,
      scope: { agentSlug: 'agent-1' },
      payload: {
        accountId: 'account-1',
        toolkit: 'gmail',
        accountStatus: 'expired',
      },
    })
    expect((request.payload as Record<string, unknown>).proxyRequestId).toBe(request.id)
    expect(syncAwaiting.get('agent-1')).toHaveBeenCalledTimes(1)

    manager.completeAccount('agent-1', 'account-1')
    expect(syncAwaiting.get('agent-1')).toHaveBeenCalledTimes(2)
    expect(syncAwaiting.get('agent-2')).not.toHaveBeenCalled()
    return expect(promise).resolves.toEqual({ outcome: 'resumed' })
  })

  it('resumes all proxy requests parked on the reconnected account', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const unrelated = manager.requestReauth({ ...DETAILS, accountId: 'account-2' })

    // Agent by agent: each agent's own calls on it go on.
    expect(manager.completeAccount('agent-1', 'account-1')).toBe(1)
    expect(manager.completeAccount('agent-2', 'account-1')).toBe(1)
    await expect(Promise.all([first, second])).resolves.toEqual([{ outcome: 'resumed' }, { outcome: 'resumed' }])
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(1)

    manager.completeAccount('agent-1', 'account-2')
    await expect(unrelated).resolves.toEqual({ outcome: 'resumed' })
  })

  it('deduplicates concurrent waits for one account into a single agent card', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)

    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeAccount('agent-1', 'account-1')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([{ outcome: 'resumed' }, { outcome: 'resumed' }])
  })

  it('keeps the shared card open when only one concurrent proxy request aborts', async () => {
    const controller = new AbortController()
    const aborted = manager.requestReauth(DETAILS, controller.signal)
    const remaining = manager.requestReauth(DETAILS)
    const rejection = expect(aborted).resolves.toEqual({ outcome: 'withdrawn' })

    controller.abort()

    await rejection
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeAccount('agent-1', 'account-1')).toBe(1)
    await expect(remaining).resolves.toEqual({ outcome: 'resumed' })
  })

  it('rejects and settles the wait after the timeout', async () => {
    const promise = manager.requestReauth(DETAILS)
    const rejection = expect(promise).resolves.toEqual({ outcome: 'timeout' })

    await vi.advanceTimersByTimeAsync(ACCOUNT_REAUTH_TIMEOUT_MS)

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('timeout')
  })

  it('cancels the wait when the proxy request is aborted', async () => {
    const controller = new AbortController()
    const promise = manager.requestReauth(DETAILS, controller.signal)
    const rejection = expect(promise).resolves.toEqual({ outcome: 'withdrawn' })

    controller.abort()

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
  })

  it('clears the card and every parked request when a user dismisses it', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(manager.dismiss(request.id, 'agent-1', 'nobody here owns it')).toBe(true)

    // The reason reaches the agent with the parked call's outcome, which the
    // proxy can tell from a timeout.
    expect(await Promise.all([first, second])).toEqual([
      { outcome: 'dismissed', reason: 'nobody here owns it' },
      { outcome: 'dismissed', reason: 'nobody here owns it' },
    ])
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('cancelled')
  })

  it('refuses a dismissal aimed at another agent', async () => {
    const promise = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    // The id is an unauthenticated pointer into a process-wide map; holding a
    // role on some other agent must not settle this one's wait.
    expect(manager.dismiss(request.id, 'agent-2')).toBe(false)
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)

    manager.completeAccount('agent-1', 'account-1')
    await expect(promise).resolves.toEqual({ outcome: 'resumed' })
  })

  it('releases all calls for a replacement while leaving other agents pending', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)
    const otherAgent = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(manager.replaceAccount(request.id, 'agent-2', 'replacement')).toBe(false)
    expect(manager.replaceAccount(request.id, 'agent-1', 'replacement')).toBe(true)
    expect(await Promise.all([first, second])).toEqual([
      { outcome: 'replaced', replacementId: 'replacement' },
      { outcome: 'replaced', replacementId: 'replacement' },
    ])
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(0)
    expect(userInputRequestManager.getAgentScopedRequests('agent-2')).toHaveLength(1)
    expect(userInputRequestManager.getRecentResolution('agent-1', request.id)?.outcome).toBe('answered')
    expect(manager.replaceAccount(request.id, 'agent-1', 'another')).toBe(false)

    manager.completeAccount('agent-2', DETAILS.accountId)
    await expect(otherAgent).resolves.toEqual({ outcome: 'resumed' })
  })

  it('reports an unknown request id as not dismissed', () => {
    expect(manager.dismiss('no-such-request', 'agent-1')).toBe(false)
  })

  describe('when the call names its session', () => {
    const cards = () => userInputRequestManager.getOpenRequestsForStore('review')
    const cardFor = (sessionId: string) => cards().find((r) => r.scope.sessionId === sessionId)!
    const resumed = { outcome: 'resumed' }

    beforeEach(() => {
      runningSessions.add('session-a')
      runningSessions.add('session-b')
    })

    it('scopes the card to that session while it runs', async () => {
      const promise = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })

      expect(cards()).toHaveLength(1)
      expect(cards()[0].scope).toEqual({ agentSlug: 'agent-1', sessionId: 'session-a' })
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-a')).toBe(true)
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-b')).toBe(false)

      manager.completeAccount('agent-1', 'account-1')
      await expect(promise).resolves.toEqual(resumed)
    })

    it('falls back to an agent-wide card when that session is not running', async () => {
      const promise = manager.requestReauth({ ...DETAILS, callerSessionId: 'ended-session' })

      expect(cards()[0].scope).toEqual({ agentSlug: 'agent-1' })
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-b')).toBe(true)

      manager.completeAccount('agent-1', 'account-1')
      await expect(promise).resolves.toEqual(resumed)
    })

    it('gives each session one card and resumes every parked call on reconnect', async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const again = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      expect(cards().map((r) => r.scope.sessionId).sort()).toEqual(['session-a', 'session-b'])

      expect(manager.completeAccount('agent-1', 'account-1')).toBe(3)
      await expect(Promise.all([first, again, other])).resolves.toEqual([resumed, resumed, resumed])
      expect(cards()).toHaveLength(0)
    })

    it("dismissing one session's card leaves the other session waiting", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      expect(manager.dismiss(cardFor('session-a').id, 'agent-1')).toBe(true)

      await expect(first).resolves.toEqual({ outcome: 'dismissed' })
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-a')).toBe(false)
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-b')).toBe(true)
      manager.completeAccount('agent-1', 'account-1')
      await expect(other).resolves.toEqual(resumed)
    })

    it("a replacement releases the agent's calls in every session", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      expect(manager.replaceAccount(cardFor('session-a').id, 'agent-1', 'replacement')).toBe(true)

      const replaced = { outcome: 'replaced', replacementId: 'replacement' }
      expect(await Promise.all([first, other])).toEqual([replaced, replaced])
      expect(cards()).toHaveLength(0)
    })

    it("a call after the session's turn ended joins the card it already shows", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      runningSessions.delete('session-a')
      const later = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })

      expect(cards().map((r) => r.scope)).toEqual([{ agentSlug: 'agent-1', sessionId: 'session-a' }])

      expect(manager.completeAccount('agent-1', 'account-1')).toBe(2)
      await expect(Promise.all([first, later])).resolves.toEqual([resumed, resumed])
    })

    it('a running session joins an agent-wide card for the same account', async () => {
      const background = manager.requestReauth({ ...DETAILS, callerSessionId: 'ended-session' })
      const running = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })

      expect(cards().map((r) => r.scope)).toEqual([{ agentSlug: 'agent-1' }])

      expect(manager.completeAccount('agent-1', 'account-1')).toBe(2)
      await expect(Promise.all([background, running])).resolves.toEqual([resumed, resumed])
    })

    it("stopping a session dismisses its parked calls and leaves the other session's", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      settleStoppedSession(agents.get('agent-1'), 'session-a')

      await expect(first).resolves.toEqual({ outcome: 'dismissed', reason: 'The session was stopped.' })
      expect(cards().map((r) => r.scope.sessionId)).toEqual(['session-b'])
      manager.completeAccount('agent-1', 'account-1')
      await expect(other).resolves.toEqual(resumed)
    })

    it("deleting a session dismisses its parked calls and leaves the other session's", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      releaseSessionState(agents.get('agent-1'), 'session-a')
      userInputRequestManager.dropSessionRequests('agent-1', 'session-a')

      await expect(first).resolves.toEqual({ outcome: 'dismissed', reason: 'The session was deleted.' })
      expect(cards().map((r) => r.scope.sessionId)).toEqual(['session-b'])
      manager.completeAccount('agent-1', 'account-1')
      await expect(other).resolves.toEqual(resumed)
    })
  })
})
