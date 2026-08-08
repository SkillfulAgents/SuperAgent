import crypto from 'crypto'
import { messagePersister } from '@shared/lib/container/message-persister'
import { userInputRequestManager } from '@shared/lib/user-input/request-manager'
import type { PendingUserInputRequest } from '@shared/lib/user-input/request-schema'

export const ACCOUNT_REAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface AccountReauthDetails {
  agentSlug: string
  accountId: string
  toolkit: string
  accountStatus: 'expired' | 'revoked'
}

interface ReauthSettler {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
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
  private settlers = new Map<string, ReauthSettler>()

  private static isAccountReauthEntry(
    request: PendingUserInputRequest,
  ): request is AccountReauthEntry {
    return request.kind === 'account_reauth_required'
  }

  private settle(
    entry: AccountReauthEntry,
    outcome: 'answered' | 'cancelled' | 'timeout',
    action: { type: 'resolve' } | { type: 'reject'; error: Error },
  ): void {
    const settler = this.settlers.get(entry.id)
    this.settlers.delete(entry.id)
    if (settler) clearTimeout(settler.timer)
    userInputRequestManager.resolve(entry.id, outcome)
    if (settler) {
      if (action.type === 'resolve') settler.resolve()
      else settler.reject(action.error)
    }
  }

  requestReauth(details: AccountReauthDetails, signal?: AbortSignal): Promise<void> {
    const id = crypto.randomUUID()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = userInputRequestManager.getOpenRequest(id)
        if (!entry || !AccountReauthManager.isAccountReauthEntry(entry)) {
          const orphan = this.settlers.get(id)
          if (!orphan) return
          this.settlers.delete(id)
          orphan.reject(new Error('Account re-authentication request was lost'))
          return
        }
        this.settle(entry, 'timeout', {
          type: 'reject',
          error: new Error('Account re-authentication timed out'),
        })
        messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
      }, ACCOUNT_REAUTH_TIMEOUT_MS)

      this.settlers.set(id, { resolve, reject, timer })

      if (signal?.aborted) {
        clearTimeout(timer)
        this.settlers.delete(id)
        reject(new Error('Proxy request aborted while awaiting re-authentication'))
        return
      }

      if (signal) {
        signal.addEventListener('abort', () => {
          const entry = userInputRequestManager.getOpenRequest(id)
          if (!entry || !AccountReauthManager.isAccountReauthEntry(entry)) return
          this.settle(entry, 'cancelled', {
            type: 'reject',
            error: new Error('Proxy request aborted while awaiting re-authentication'),
          })
          messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
        }, { once: true })
      }

      const registered = userInputRequestManager.register({
        id,
        kind: 'account_reauth_required',
        scope: { agentSlug: details.agentSlug },
        blocking: true,
        autoApproved: false,
        payload: {
          accountId: details.accountId,
          toolkit: details.toolkit,
          accountStatus: details.accountStatus,
          proxyRequestId: id,
        },
      })

      if (!registered) {
        clearTimeout(timer)
        this.settlers.delete(id)
        reject(new Error('Failed to register account re-authentication request'))
        return
      }

      messagePersister.syncAgentSessionsAwaiting(details.agentSlug)
    })
  }

  /** Resume every parked proxy request that uses the reconnected account. */
  completeAccount(accountId: string): number {
    const agentSlugs = new Set<string>()
    let completed = 0

    for (const request of userInputRequestManager.getOpenRequestsForStore('review')) {
      if (!AccountReauthManager.isAccountReauthEntry(request)) continue
      const payload = request.payload as Record<string, unknown>
      if (payload.accountId !== accountId) continue
      if (request.scope.agentSlug) agentSlugs.add(request.scope.agentSlug)
      this.settle(request, 'answered', { type: 'resolve' })
      completed++
    }

    for (const agentSlug of agentSlugs) {
      messagePersister.syncAgentSessionsAwaiting(agentSlug)
    }
    return completed
  }

  rejectAll(): void {
    const agentSlugs = new Set<string>()
    for (const request of userInputRequestManager.getOpenRequestsForStore('review')) {
      if (!AccountReauthManager.isAccountReauthEntry(request)) continue
      if (request.scope.agentSlug) agentSlugs.add(request.scope.agentSlug)
      this.settle(request, 'cancelled', {
        type: 'reject',
        error: new Error('Account re-authentication interrupted by shutdown'),
      })
    }

    // Defensive cleanup for a settler whose registry entry disappeared.
    for (const [id, settler] of this.settlers) {
      clearTimeout(settler.timer)
      this.settlers.delete(id)
      settler.reject(new Error('Account re-authentication interrupted by shutdown'))
    }

    for (const agentSlug of agentSlugs) {
      messagePersister.syncAgentSessionsAwaiting(agentSlug)
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
