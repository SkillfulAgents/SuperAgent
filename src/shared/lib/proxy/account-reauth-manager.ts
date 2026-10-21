import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import type { AccountReauthDetails, AccountReauthWaits, ReauthOutcome } from './reauth-waits'
import { awaitReauth } from './reauth-request'

export {
  ACCOUNT_REAUTH_TIMEOUT_MS,
  createAccountReauthWaits,
  type AccountReauthDetails,
  type AccountReauthRequest,
  type AccountReauthWaits,
} from './reauth-waits'

/**
 * The router in front of every agent's account re-auth waits. The waits live
 * in each agent's actor (`AgentReauthWaits`, see `reauth-waits`); this
 * singleton dispatches the calls that arrive with a slug and runs the ones
 * that span agents — completing an account resumes every agent's requests
 * parked on it, and shutdown rejects them all.
 */
export class AccountReauthManager {
  private readonly agents = new AttachedStores<AccountReauthWaits>('account re-auth waits')

  /** Called once by the agent registry with the way to each agent's waits. */
  attachAgents(directory: AgentStoreDirectory<AccountReauthWaits> | null): void {
    this.agents.attach(directory)
  }

  /** Park a request of the agent on its re-auth card and wait for how it ends (see `awaitReauth`). */
  requestReauth(details: AccountReauthDetails, signal?: AbortSignal): Promise<ReauthOutcome> {
    const waits = this.agents.get(details.agentSlug)
    return awaitReauth(waits, details, signal)
  }

  /** `AgentReauthWaits.request` on the agent's waits: the outcome as data. */
  request(agentSlug: string, details: Omit<AccountReauthDetails, 'agentSlug'>, options: { waitId: string }): Promise<ReauthOutcome> {
    return this.agents.get(agentSlug).request(details, options)
  }

  /** `AgentReauthWaits.withdraw` on the agent's waits. */
  withdraw(agentSlug: string, waitId: string): void {
    this.agents.peek(agentSlug)?.withdraw(waitId)
  }

  /** `AgentReauthWaits.dismiss` on the agent's waits; false when it holds no such card. */
  dismiss(entryId: string, agentSlug: string, reason?: string): boolean {
    return this.agents.peek(agentSlug)?.dismiss(entryId, reason) ?? false
  }

  /** Release only this agent's calls; other agents still use the old account. */
  replaceAccount(entryId: string, agentSlug: string, replacementAccountId: string): boolean {
    return this.agents.peek(agentSlug)?.replace(entryId, replacementAccountId) ?? false
  }

  /** Resume every parked proxy request, of every agent, that uses the reconnected account. */
  completeAccount(accountId: string): number {
    let completed = 0
    for (const waits of this.agents.all()) completed += waits.complete(accountId)
    return completed
  }

  rejectAll(): void {
    for (const waits of this.agents.all()) waits.rejectAll()
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
