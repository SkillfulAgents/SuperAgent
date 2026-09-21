/**
 * The in-memory state one agent owns: its pending user-input requests, the
 * reviews and re-auth waits parked on them, and its computer-use grants.
 *
 * Created with the agent's actor and released with it, so `agentRegistry.evict`
 * is the one operation that ends everything an agent held in this process.
 * The stores know nothing of other agents; the process-wide routers
 * (`userInputRequestManager` and friends) reach them through the directory
 * the registry attaches.
 */
import { AgentInputRequests, type UserInputTransitionSink } from '@shared/lib/user-input/agent-input-requests'
import { AgentReviews } from '@shared/lib/proxy/agent-reviews'
import {
  createAccountReauthWaits,
  createMcpReauthWaits,
  type AccountReauthWaits,
  type McpReauthWaits,
} from '@shared/lib/proxy/reauth-waits'
import { AgentComputerUse } from '@shared/lib/computer-use/agent-permissions'
import type { AgentSlug } from './types'

export interface AgentState {
  readonly inputRequests: AgentInputRequests
  readonly reviews: AgentReviews
  readonly accountReauth: AccountReauthWaits
  readonly mcpReauth: McpReauthWaits
  readonly computerUse: AgentComputerUse
}

export interface AgentStateHooks {
  /** Where the agent's request transitions go: the router that indexes and fans them out. */
  transitions: UserInputTransitionSink
  /** Recompute the agent's sessions' awaiting state after a card opens or closes. */
  syncAwaiting: () => void
}

export function createAgentState(slug: AgentSlug, hooks: AgentStateHooks): AgentState {
  const inputRequests = new AgentInputRequests(slug, hooks.transitions)
  return {
    inputRequests,
    reviews: new AgentReviews(slug, inputRequests, hooks.syncAwaiting),
    accountReauth: createAccountReauthWaits(slug, inputRequests, hooks.syncAwaiting),
    mcpReauth: createMcpReauthWaits(slug, inputRequests, hooks.syncAwaiting),
    computerUse: new AgentComputerUse(slug),
  }
}

/**
 * The agent is gone from this process: reject every parked call, settle
 * every open request so its listeners hear the end of it, and forget the
 * rest. The persisted computer-use grants are left where they are; they
 * belong to the agent's settings entry, not to the process.
 */
export function releaseAgentState(state: AgentState): void {
  const gone = (what: string) => new Error(`${what} dropped: the agent is no longer held by this process`)
  state.reviews.rejectAll()
  state.accountReauth.rejectAll(gone('Account re-authentication'))
  state.mcpReauth.rejectAll(gone('MCP re-authentication'))
  state.inputRequests.dispose()
  state.computerUse.clearGrabbed()
}
