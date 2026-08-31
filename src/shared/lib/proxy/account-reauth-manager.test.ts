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
import { isReauthDismissed } from './reauth-dismissal'

const DETAILS = {
  agentSlug: 'agent-1',
  accountId: 'account-1',
  toolkit: 'gmail',
  accountStatus: 'expired' as const,
}

describe('AccountReauthManager', () => {
  let manager: AccountReauthManager

  beforeEach(() => {
    vi.useFakeTimers()
    userInputRequestManager.reset()
    mockSyncAgentSessionsAwaiting.mockReset()
    manager = new AccountReauthManager()
  })

  afterEach(() => {
    manager.rejectAll()
    userInputRequestManager.reset()
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

  it('reports an unknown request id as not dismissed', () => {
    expect(manager.dismiss('no-such-request', 'agent-1')).toBe(false)
  })
})
