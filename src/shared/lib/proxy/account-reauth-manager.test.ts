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
})
