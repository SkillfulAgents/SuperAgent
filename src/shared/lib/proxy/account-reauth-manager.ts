import crypto from 'crypto'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'
import { ReauthDismissedError, reauthDismissedMessage } from './reauth-dismissal'

export const ACCOUNT_REAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface AccountReauthDetails {
  agentSlug: string
  accountId: string
  toolkit: string
  accountStatus: 'expired' | 'revoked'
}

interface ReauthWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface AccountReauthGroup {
  key: string
  entryId: string
  agentSlug: string
  accountId: string
  waiters: Set<ReauthWaiter>
}

type AccountReauthEntry = Extract<PendingUserInputRequest, { kind: 'account_reauth_required' }>

/**
 * Parks proxy requests while an expired/revoked account is re-authorized.
 *
 * The user-input registry is the durable announcement channel: registering an
 * account_reauth_required envelope broadcasts the unified SSE created event.
 * Its payload carries accountId, toolkit, and proxyRequestId. The envelope
 * also keeps every session for the agent in the awaiting-input state. This
 * class owns only the in-memory promise settlers that let the original HTTP
 * request resume after the OAuth completion route activates the account.
 */
export class AccountReauthManager {
  private groups = new Map<string, AccountReauthGroup>()
  private entryIdByKey = new Map<string, string>()

  private static isAccountReauthEntry(
    request: PendingUserInputRequest,
  ): request is AccountReauthEntry {
    return request.kind === 'account_reauth_required'
  }

  private cleanupWaiter(waiter: ReauthWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private settleGroup(
    group: AccountReauthGroup,
    outcome: 'answered' | 'cancelled' | 'timeout',
    action: { type: 'resolve' } | { type: 'reject'; error: Error },
  ): number {
    this.groups.delete(group.entryId)
    if (this.entryIdByKey.get(group.key) === group.entryId) {
      this.entryIdByKey.delete(group.key)
    }

    const entry = userInputRequestManager.getOpenRequest(group.entryId)
    if (entry && AccountReauthManager.isAccountReauthEntry(entry)) {
      userInputRequestManager.resolve(entry.id, outcome)
    }

    const waiters = [...group.waiters]
    group.waiters.clear()
    for (const waiter of waiters) {
      this.cleanupWaiter(waiter)
      if (action.type === 'resolve') waiter.resolve()
      else waiter.reject(action.error)
    }
    messagePersister.syncAgentSessionsAwaiting(group.agentSlug)
    return waiters.length
  }

  private rejectWaiter(
    group: AccountReauthGroup,
    waiter: ReauthWaiter,
    outcome: 'cancelled' | 'timeout',
    error: Error,
  ): void {
    if (!group.waiters.delete(waiter)) return
    this.cleanupWaiter(waiter)
    waiter.reject(error)

    // Keep the shared card open while another HTTP request is still parked on
    // the same credential. The final waiter owns the registry resolution.
    if (group.waiters.size > 0) return

    this.groups.delete(group.entryId)
    if (this.entryIdByKey.get(group.key) === group.entryId) {
      this.entryIdByKey.delete(group.key)
    }
    const entry = userInputRequestManager.getOpenRequest(group.entryId)
    if (entry && AccountReauthManager.isAccountReauthEntry(entry)) {
      userInputRequestManager.resolve(entry.id, outcome)
    }
    messagePersister.syncAgentSessionsAwaiting(group.agentSlug)
  }

  requestReauth(details: AccountReauthDetails, signal?: AbortSignal): Promise<void> {
    // Requests share one credential but the registry scope can name only one
    // agent. Deduplicate within that visible scope; completing the account
    // still settles every group across every assigned agent.
    const key = `${details.agentSlug}\0${details.accountId}`
    const existingId = this.entryIdByKey.get(key)
    let group = existingId ? this.groups.get(existingId) : undefined
    let isNewGroup = false

    if (group) {
      const entry = userInputRequestManager.getOpenRequest(group.entryId)
      if (!entry || !AccountReauthManager.isAccountReauthEntry(entry)) {
        this.settleGroup(group, 'cancelled', {
          type: 'reject',
          error: new Error('Account re-authentication request was lost'),
        })
        group = undefined
      }
    }

    if (!group) {
      if (existingId) this.entryIdByKey.delete(key)
      const entryId = crypto.randomUUID()
      group = {
        key,
        entryId,
        agentSlug: details.agentSlug,
        accountId: details.accountId,
        waiters: new Set(),
      }
      this.groups.set(entryId, group)
      this.entryIdByKey.set(key, entryId)
      isNewGroup = true
    }

    const activeGroup = group

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        if (isNewGroup && activeGroup.waiters.size === 0) {
          this.groups.delete(activeGroup.entryId)
          this.entryIdByKey.delete(activeGroup.key)
        }
        reject(new Error('Proxy request aborted while awaiting re-authentication'))
        return
      }

      let waiter: ReauthWaiter
      const timer = setTimeout(() => {
        this.rejectWaiter(
          activeGroup,
          waiter,
          'timeout',
          new Error('Account re-authentication timed out'),
        )
      }, ACCOUNT_REAUTH_TIMEOUT_MS)

      waiter = { resolve, reject, timer, signal }
      if (signal) {
        waiter.onAbort = () => {
          this.rejectWaiter(
            activeGroup,
            waiter,
            'cancelled',
            new Error('Proxy request aborted while awaiting re-authentication'),
          )
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      activeGroup.waiters.add(waiter)

      if (!isNewGroup) return

      const registered = userInputRequestManager.register({
        id: activeGroup.entryId,
        kind: 'account_reauth_required',
        scope: { agentSlug: details.agentSlug },
        blocking: true,
        autoApproved: false,
        payload: {
          accountId: details.accountId,
          toolkit: details.toolkit,
          accountStatus: details.accountStatus,
          proxyRequestId: activeGroup.entryId,
        },
      })

      if (!registered) {
        this.settleGroup(activeGroup, 'cancelled', {
          type: 'reject',
          error: new Error('Failed to register account re-authentication request'),
        })
        return
      }

      messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
    })
  }

  /**
   * Give up on one parked card because a person dismissed it. Without this the
   * only exits are the owner reconnecting or the five-minute timer, so a
   * shared credential nobody present can reconnect holds every session of the
   * agent in awaiting-input until it expires.
   *
   * Returns false when `entryId` names no live group under `agentSlug` — the
   * caller decides whether that is a stale card or a cross-agent probe.
   */
  dismiss(entryId: string, agentSlug: string, reason?: string): boolean {
    const group = this.groups.get(entryId)
    if (!group || group.agentSlug !== agentSlug) return false
    this.settleGroup(group, 'cancelled', {
      type: 'reject',
      error: new ReauthDismissedError(
        reauthDismissedMessage('Account re-authentication', reason),
        reason,
      ),
    })
    return true
  }

  /** Resume every parked proxy request that uses the reconnected account. */
  completeAccount(accountId: string): number {
    let completed = 0
    for (const group of [...this.groups.values()]) {
      if (group.accountId !== accountId) continue
      completed += this.settleGroup(group, 'answered', { type: 'resolve' })
    }
    return completed
  }

  rejectAll(): void {
    for (const group of [...this.groups.values()]) {
      this.settleGroup(group, 'cancelled', {
        type: 'reject',
        error: new Error('Account re-authentication interrupted by shutdown'),
      })
    }
  }
}

const globalForAccountReauthManager = globalThis as unknown as {
  accountReauthManager: AccountReauthManager | undefined
}

export const accountReauthManager =
  globalForAccountReauthManager.accountReauthManager ?? new AccountReauthManager()

if (process.env.NODE_ENV !== 'production') {
  globalForAccountReauthManager.accountReauthManager = accountReauthManager
}
