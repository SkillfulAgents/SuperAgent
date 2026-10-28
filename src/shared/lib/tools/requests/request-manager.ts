import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import type { AgentInputRequests, SettledUserInputRequest } from './agent-input-requests'
import type {
  PendingUserInputRequest,
  PendingUserInputRequestInput,
  UserInputRequestOutcome,
  UserInputRequestStore,
} from './request-schema'

export type { SettledUserInputRequest, UserInputRequestTransition } from './agent-input-requests'

/**
 * The router in front of every agent's pending user-input requests.
 *
 * The requests themselves live in each agent's `AgentInputRequests`, owned by
 * its actor, and the agent's own live sessions put their transitions on the
 * wire. This singleton holds no state: it dispatches a call that names an
 * agent to that agent's store, and runs the sweeps across every agent.
 *
 * Every id-addressed method names the agent. An id can be open in more than
 * one agent's store (a session cloned into another agent replays the tool-use
 * ids of its source), and only the named agent's store is consulted, so an id
 * another agent holds is simply not found.
 *
 * The agent's actor calls its store directly. A read for an agent that has no
 * handle finds nothing — no request can exist for it.
 */
export class UserInputRequestManager {
  private readonly agents = new AttachedStores<AgentInputRequests>('user-input requests')

  /** Called by the agent registry with the way to each agent's store. */
  attachAgents(directory: AgentStoreDirectory<AgentInputRequests> | null): void {
    this.agents.attach(directory)
  }

  /**
   * Register a pending request with the agent its scope names. The agent's
   * store applies first-delivery-wins and the recovered-synthetic upgrade;
   * see `AgentInputRequests.register`. An envelope that names no agent has no
   * store to live in: it is logged and dropped, never thrown.
   */
  register(input: PendingUserInputRequestInput): PendingUserInputRequest | null {
    const slug = input.scope?.agentSlug
    if (!slug) {
      console.error(`[UserInputRequestManager] Dropped request registration without an agent (id=${input.id})`)
      return null
    }
    return this.agents.get(slug).register(input)
  }

  /** Settle and remove a request. Idempotent: unknown ids are a no-op (null). */
  resolve(agentSlug: AgentSlug, id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null {
    return this.agents.peek(agentSlug)?.resolve(id, outcome) ?? null
  }

  /** `AgentInputRequests.resolveIfInStore` on the agent's store. */
  resolveIfInStore(
    agentSlug: AgentSlug,
    id: string,
    store: UserInputRequestStore,
    outcome: UserInputRequestOutcome,
  ): PendingUserInputRequest | null {
    return this.agents.peek(agentSlug)?.resolveIfInStore(id, store, outcome) ?? null
  }

  /** Mirror of the turn-boundary `pendingInputRequests.clear()` — stream store only. */
  clearSessionStreamRequests(agentSlug: string, sessionId: string, outcome: UserInputRequestOutcome): void {
    this.agents.peek(agentSlug)?.clearSessionStreamRequests(sessionId, outcome)
  }

  /**
   * Settle every open request of the agent registered under a parent Task
   * tool_use — the dead-subagent sweep. Returns what was settled.
   */
  resolveRequestsByParent(
    agentSlug: AgentSlug,
    parentToolUseId: string,
    outcome: UserInputRequestOutcome = 'invalidated',
  ): PendingUserInputRequest[] {
    return this.agents.peek(agentSlug)?.resolveRequestsByParent(parentToolUseId, outcome) ?? []
  }

  /** Mirror of `streamingStates.delete` — every session-scoped entry dies with the state. */
  dropSessionRequests(
    agentSlug: string,
    sessionId: string,
    outcome: UserInputRequestOutcome = 'invalidated',
  ): void {
    this.agents.peek(agentSlug)?.dropSessionRequests(sessionId, outcome)
  }

  /** Look up a single open request of the agent by id. */
  getOpenRequest(agentSlug: AgentSlug, id: string): PendingUserInputRequest | null {
    return this.agents.peek(agentSlug)?.getOpenRequest(id) ?? null
  }

  /** `AgentInputRequests.enrichOpenRequestPayload` on the agent's store. */
  enrichOpenRequestPayload(
    agentSlug: AgentSlug,
    id: string,
    kind: PendingUserInputRequest['kind'],
    enrichment: Record<string, unknown>,
  ): boolean {
    return this.agents.peek(agentSlug)?.enrichOpenRequestPayload(id, kind, enrichment) ?? false
  }

  /** `AgentInputRequests.claimRequest` on the agent's store. */
  claimRequest(agentSlug: AgentSlug, id: string): { token: string; request: PendingUserInputRequest } | null {
    return this.agents.peek(agentSlug)?.claimRequest(id) ?? null
  }

  /** Drop the claim this token holds. No-op for an id that already settled. */
  releaseClaim(agentSlug: AgentSlug, id: string, token: string): void {
    this.agents.peek(agentSlug)?.releaseClaim(id, token)
  }

  /** How a request of the agent settled, while its trail still remembers it. */
  getRecentResolution(agentSlug: AgentSlug, id: string): SettledUserInputRequest | undefined {
    return this.agents.peek(agentSlug)?.getRecentResolution(id)
  }

  getOpenRequestsForSession(agentSlug: string, sessionId: string): PendingUserInputRequest[] {
    return this.agents.peek(agentSlug)?.getOpenRequestsForSession(sessionId) ?? []
  }

  /** Every open request of a legacy store, across all agents (e.g. shutdown sweeps). */
  getOpenRequestsForStore(store: UserInputRequestStore): PendingUserInputRequest[] {
    return this.agents.all().flatMap((agent) => agent.getOpenRequestsForStore(store))
  }

  /** Session-scoped AND agent-scoped entries for the agent. */
  getOpenRequestsForAgent(agentSlug: string): PendingUserInputRequest[] {
    return this.agents.peek(agentSlug)?.getOpenRequests() ?? []
  }

  /** Agent-scoped only (no sessionId) — reviews and re-auth requests. */
  getAgentScopedRequests(agentSlug: string): PendingUserInputRequest[] {
    return this.agents.peek(agentSlug)?.getAgentScopedRequests() ?? []
  }

  /**
   * Wire snapshot for a scope; see `AgentInputRequests.getSnapshotForScope`.
   * The agent is looked up first, unconditionally: sessionId arrives from an
   * unvalidated query param behind an AgentRead gate on the agent alone, and
   * another agent's store is never consulted.
   */
  getSnapshotForScope(agentSlug: string, sessionId?: string): PendingUserInputRequest[] {
    return this.agents.peek(agentSlug)?.getSnapshotForScope(sessionId) ?? []
  }

  getStoreIdsForSession(agentSlug: string, sessionId: string, store: UserInputRequestStore): string[] {
    return this.agents.peek(agentSlug)?.getStoreIdsForSession(sessionId, store) ?? []
  }

  /** Derived awaiting projection for a session; see `AgentInputRequests.isSessionAwaiting`. */
  isSessionAwaiting(agentSlug: string, sessionId: string): boolean {
    return this.agents.peek(agentSlug)?.isSessionAwaiting(sessionId) ?? false
  }

  isAgentAwaiting(agentSlug: string): boolean {
    return this.agents.peek(agentSlug)?.isAwaiting() ?? false
  }

  get stats(): {
    open: number
    /** In-flight decision reservations. A non-zero idle value is a leaked claim. */
    claimed: number
    mismatches: number
    recentResolutions: SettledUserInputRequest[]
  } {
    const stores = this.agents.all().map((store) => store.stats)
    return {
      open: stores.reduce((n, s) => n + s.open, 0),
      claimed: stores.reduce((n, s) => n + s.claimed, 0),
      mismatches: stores.reduce((n, s) => n + s.mismatches, 0),
      // Oldest first across agents, as one trail would hold them.
      recentResolutions: this.agents
        .all()
        .flatMap((store) => store.recentSettlements())
        .sort((a, b) => a.seq - b.seq)
        .map((entry) => entry.record),
    }
  }

  /** Test hook: wipe every agent's store, silently. */
  reset(): void {
    for (const store of this.agents.all()) store.reset()
  }
}

// Use globalThis to persist across dev-server hot reloads, matching the agents'
// state and reviewManager — the agents' stores report their transitions to this
// router, and they survive reloads, so the router must too or a reload would
// strand their open requests in a stale instance.
const globalForUserInputRequestManager = globalThis as unknown as {
  userInputRequestManager: UserInputRequestManager | undefined
}

export const userInputRequestManager =
  globalForUserInputRequestManager.userInputRequestManager ?? new UserInputRequestManager()

if (process.env.NODE_ENV !== 'production') {
  globalForUserInputRequestManager.userInputRequestManager = userInputRequestManager
}
