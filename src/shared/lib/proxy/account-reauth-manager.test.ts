import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSyncAgentSessionsAwaiting = vi.fn()

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    syncAgentSessionsAwaiting: (...args: unknown[]) => mockSyncAgentSessionsAwaiting(...args),
  },
}))

import {
  ACCOUNT_REAUTH_TIMEOUT_MS,
  AccountReauthManager,
} from './account-reauth-manager'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import {
  attachInMemoryAgentState,
  type InMemoryAgentStateDirectory,
} from '@shared/lib/agent-actor/testing/in-memory-agent-state'
import { isReauthDismissed } from './reauth-dismissal'
import { releaseSessionState } from '@shared/lib/agent-actor/agent-state'
import { getReplacementAccountId } from './account-replacement'

const DETAILS = {
  agentSlug: 'agent-1',
  accountId: 'account-1',
  toolkit: 'gmail',
  accountStatus: 'expired' as const,
}

describe('AccountReauthManager', () => {
  let manager: AccountReauthManager
  let agents: InMemoryAgentStateDirectory
  const runningSessions = new Set<string>()

  beforeEach(() => {
    vi.useFakeTimers()
    mockSyncAgentSessionsAwaiting.mockReset()
    runningSessions.clear()
    // The waits live on the agents' actors; the manager under test routes to
    // them. Build the actors' stores in memory, attached the way the registry
    // attaches the real handles.
    agents = attachInMemoryAgentState({
      syncAwaiting: (slug) => mockSyncAgentSessionsAwaiting(slug),
      isSessionActive: (_slug, sessionId) => runningSessions.has(sessionId),
    })
    manager = new AccountReauthManager()
    manager.attachAgents(agents.pick((state) => state.accountReauth))
    userInputRequestManager.reset()
  })

  afterEach(() => {
    manager.rejectAll()
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

    manager.completeAccount('account-1')
    return expect(promise).resolves.toBeUndefined()
  })

  it('resumes all proxy requests parked on the reconnected account', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const unrelated = manager.requestReauth({ ...DETAILS, accountId: 'account-2' })

    expect(manager.completeAccount('account-1')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(1)

    manager.completeAccount('account-2')
    await expect(unrelated).resolves.toBeUndefined()
  })

  it('deduplicates concurrent waits for one account into a single agent card', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)

    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeAccount('account-1')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('keeps the shared card open when only one concurrent proxy request aborts', async () => {
    const controller = new AbortController()
    const aborted = manager.requestReauth(DETAILS, controller.signal)
    const remaining = manager.requestReauth(DETAILS)
    const rejection = expect(aborted).rejects.toThrow('aborted')

    controller.abort()

    await rejection
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(1)
    expect(manager.completeAccount('account-1')).toBe(1)
    await expect(remaining).resolves.toBeUndefined()
  })

  it('rejects and settles the wait after the timeout', async () => {
    const promise = manager.requestReauth(DETAILS)
    const rejection = expect(promise).rejects.toThrow('timed out')

    await vi.advanceTimersByTimeAsync(ACCOUNT_REAUTH_TIMEOUT_MS)

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
    expect(userInputRequestManager.stats.recentResolutions.at(-1)?.outcome).toBe('timeout')
  })

  it('cancels the wait when the proxy request is aborted', async () => {
    const controller = new AbortController()
    const promise = manager.requestReauth(DETAILS, controller.signal)
    const rejection = expect(promise).rejects.toThrow('aborted')

    controller.abort()

    await rejection
    expect(userInputRequestManager.getOpenRequestsForStore('review')).toHaveLength(0)
  })

  it('clears the card and every parked request when a user dismisses it', async () => {
    const first = manager.requestReauth(DETAILS)
    const second = manager.requestReauth(DETAILS)
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')
    const rejections = Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ])

    expect(manager.dismiss(request.id, 'agent-1', 'nobody here owns it')).toBe(true)

    // The reason reaches the agent through the parked call's failure, and the
    // failure is flagged so the proxy can call it a dismissal, not a timeout.
    for (const error of await rejections) {
      expect(isReauthDismissed(error)).toBe(true)
      expect((error as Error).message).toContain('nobody here owns it')
    }
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

    manager.completeAccount('account-1')
    await expect(promise).resolves.toBeUndefined()
  })

  it('releases all calls for a replacement while leaving other agents pending', async () => {
    const first = manager.requestReauth(DETAILS).catch(getReplacementAccountId)
    const second = manager.requestReauth(DETAILS).catch(getReplacementAccountId)
    const otherAgent = manager.requestReauth({ ...DETAILS, agentSlug: 'agent-2' })
    const [request] = userInputRequestManager.getAgentScopedRequests('agent-1')

    expect(manager.replaceAccount(request.id, 'agent-2', 'replacement')).toBe(false)
    expect(manager.replaceAccount(request.id, 'agent-1', 'replacement')).toBe(true)
    expect(await Promise.all([first, second])).toEqual(['replacement', 'replacement'])
    expect(userInputRequestManager.getAgentScopedRequests('agent-1')).toHaveLength(0)
    expect(userInputRequestManager.getAgentScopedRequests('agent-2')).toHaveLength(1)
    expect(userInputRequestManager.getRecentResolution(request.id)?.outcome).toBe('answered')
    expect(manager.replaceAccount(request.id, 'agent-1', 'another')).toBe(false)

    manager.completeAccount(DETAILS.accountId)
    await expect(otherAgent).resolves.toBeUndefined()
  })

  it('reports an unknown request id as not dismissed', () => {
    expect(manager.dismiss('no-such-request', 'agent-1')).toBe(false)
  })

  describe('when the call names its session', () => {
    const cards = () => userInputRequestManager.getOpenRequestsForStore('review')
    const cardFor = (sessionId: string) => cards().find((r) => r.scope.sessionId === sessionId)!

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

      manager.completeAccount('account-1')
      await expect(promise).resolves.toBeUndefined()
    })

    it('falls back to an agent-wide card when that session is not running', async () => {
      const promise = manager.requestReauth({ ...DETAILS, callerSessionId: 'ended-session' })

      expect(cards()[0].scope).toEqual({ agentSlug: 'agent-1' })
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-b')).toBe(true)

      manager.completeAccount('account-1')
      await expect(promise).resolves.toBeUndefined()
    })

    it('gives each session one card and resumes every parked call on reconnect', async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const again = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' })
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      expect(cards().map((r) => r.scope.sessionId).sort()).toEqual(['session-a', 'session-b'])

      expect(manager.completeAccount('account-1')).toBe(3)
      await expect(Promise.all([first, again, other])).resolves.toEqual([undefined, undefined, undefined])
      expect(cards()).toHaveLength(0)
    })

    it("dismissing one session's card leaves the other session waiting", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' }).catch((error: unknown) => error)
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      expect(manager.dismiss(cardFor('session-a').id, 'agent-1')).toBe(true)

      expect(isReauthDismissed(await first)).toBe(true)
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-a')).toBe(false)
      expect(userInputRequestManager.isSessionAwaiting('agent-1', 'session-b')).toBe(true)
      manager.completeAccount('account-1')
      await expect(other).resolves.toBeUndefined()
    })

    it("a replacement releases the agent's calls in every session", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' }).catch(getReplacementAccountId)
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' }).catch(getReplacementAccountId)

      expect(manager.replaceAccount(cardFor('session-a').id, 'agent-1', 'replacement')).toBe(true)

      expect(await Promise.all([first, other])).toEqual(['replacement', 'replacement'])
      expect(cards()).toHaveLength(0)
    })

    it("deleting a session dismisses its parked calls and leaves the other session's", async () => {
      const first = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-a' }).catch((error: unknown) => error)
      const other = manager.requestReauth({ ...DETAILS, callerSessionId: 'session-b' })

      releaseSessionState(agents.states.get('agent-1')!, 'session-a')
      userInputRequestManager.dropSessionRequests('agent-1', 'session-a')

      expect(isReauthDismissed(await first)).toBe(true)
      expect(cards().map((r) => r.scope.sessionId)).toEqual(['session-b'])
      manager.completeAccount('account-1')
      await expect(other).resolves.toBeUndefined()
    })
  })
})
