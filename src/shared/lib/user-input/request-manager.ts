import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { AttachedStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import {
  AgentInputRequests,
  type SettledUserInputRequest,
  type UserInputRequestTransition,
  type UserInputTransitionSink,
} from './agent-input-requests'
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
 * its actor. This singleton holds only what spans agents: the index from
 * request id to owning agent (so a decision that arrives with a bare id finds
 * its store), the transition listeners (the single feed for the unified wire
 * events), and the process-wide sweeps. Every store reports its transitions
 * here, which is what keeps the index current.
 *
 * The slug-addressed methods dispatch to that agent's store; the agent's
 * actor calls its store directly. A read for an agent that has no handle
 * finds nothing — no request can exist for it.
 */
export class UserInputRequestManager implements UserInputTransitionSink {
  private readonly agents = new AttachedStores<AgentInputRequests>('user-input requests')

  /** Which agent's store holds each open request. */
  private ownerById = new Map<string, AgentSlug>()

  private transitionListeners = new Set<(transition: UserInputRequestTransition) => void>()

  /** Called once by the agent registry with the way to each agent's store. */
  attachAgents(directory: AgentStoreDirectory<AgentInputRequests> | null): void {
    this.agents.attach(directory)
    this.ownerById.clear()
  }

  /** A store's transition: index it, then fan it out. */
  report(transition: UserInputRequestTransition): void {
    const slug = transition.request.scope.agentSlug
    if (transition.type === 'created' && slug !== undefined) {
      this.ownerById.set(transition.request.id, slug)
    } else if (transition.type === 'resolved') {
      this.ownerById.delete(transition.request.id)
    }
    this.emitTransition(transition)
  }

  private ownerOf(id: string): AgentInputRequests | undefined {
    const slug = this.ownerById.get(id)
    return slug === undefined ? undefined : this.agents.peek(slug)
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
  resolve(id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null {
    return this.ownerOf(id)?.resolve(id, outcome) ?? null
  }

  /**
   * Subscribe to transitions from every agent's store. Listener errors are
   * swallowed: wire fan-out must never break the mutation path that
   * triggered it.
   */
  onTransition(listener: (transition: UserInputRequestTransition) => void): () => void {
    this.transitionListeners.add(listener)
    return () => this.transitionListeners.delete(listener)
  }

  private emitTransition(transition: UserInputRequestTransition): void {
    for (const listener of this.transitionListeners) {
      try {
        listener(transition)
      } catch (error) {
        console.error('[UserInputRequestManager] transition listener failed:', error)
      }
    }
  }

  /** `AgentInputRequests.resolveIfInStore` on the request's owner. */
  resolveIfInStore(
    id: string,
    store: UserInputRequestStore,
    outcome: UserInputRequestOutcome,
  ): PendingUserInputRequest | null {
    return this.ownerOf(id)?.resolveIfInStore(id, store, outcome) ?? null
  }

  /** Mirror of the turn-boundary `pendingInputRequests.clear()` — stream store only. */
  clearSessionStreamRequests(agentSlug: string, sessionId: string, outcome: UserInputRequestOutcome): void {
    this.agents.peek(agentSlug)?.clearSessionStreamRequests(sessionId, outcome)
  }

  /**
   * Settle every open request registered under a parent Task tool_use — the
   * dead-subagent sweep, across every agent. Returns what was settled.
   */
  resolveRequestsByParent(
    parentToolUseId: string,
    outcome: UserInputRequestOutcome = 'invalidated',
  ): PendingUserInputRequest[] {
    return this.agents.all().flatMap((store) => store.resolveRequestsByParent(parentToolUseId, outcome))
  }

  /** Mirror of `streamingStates.delete` — every session-scoped entry dies with the state. */
  dropSessionRequests(
    agentSlug: string,
    sessionId: string,
    outcome: UserInputRequestOutcome = 'invalidated',
  ): void {
    this.agents.peek(agentSlug)?.dropSessionRequests(sessionId, outcome)
  }

  /** Look up a single open request by id, whichever agent holds it. */
  getOpenRequest(id: string): PendingUserInputRequest | null {
    return this.ownerOf(id)?.getOpenRequest(id) ?? null
  }

  /** `AgentInputRequests.enrichOpenRequestPayload` on the request's owner. */
  enrichOpenRequestPayload(
    id: string,
    kind: PendingUserInputRequest['kind'],
    enrichment: Record<string, unknown>,
  ): boolean {
    return this.ownerOf(id)?.enrichOpenRequestPayload(id, kind, enrichment) ?? false
  }

  /** `AgentInputRequests.claimRequest` on the request's owner. */
  claimRequest(id: string): PendingUserInputRequest | null {
    return this.ownerOf(id)?.claimRequest(id) ?? null
  }

  /** Drop a claim. No-op for an id that already settled. */
  releaseClaim(id: string): void {
    this.ownerOf(id)?.releaseClaim(id)
  }

  /**
   * How a request settled, from whichever agent's trail still remembers it —
   * the newest settlement when an id was registered under more than one agent.
   */
  getRecentResolution(id: string): SettledUserInputRequest | undefined {
    let newest: { record: SettledUserInputRequest; seq: number } | undefined
    for (const store of this.agents.all()) {
      const settled = store.recentSettlement(id)
      if (settled && (!newest || settled.seq > newest.seq)) newest = settled
    }
    return newest?.record
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

  /** Test hook: wipe every agent's store and the index, silently. */
  reset(): void {
    for (const store of this.agents.all()) store.reset()
    this.ownerById.clear()
  }
}

// Use globalThis to persist across dev-server hot reloads, matching
// messagePersister and reviewManager — both write through to this registry, and
// they survive reloads, so the registry must too or a reload would strand their
// open requests in a stale instance.
const globalForUserInputRequestManager = globalThis as unknown as {
  userInputRequestManager: UserInputRequestManager | undefined
}

export const userInputRequestManager =
  globalForUserInputRequestManager.userInputRequestManager ?? new UserInputRequestManager()

if (process.env.NODE_ENV !== 'production') {
  globalForUserInputRequestManager.userInputRequestManager = userInputRequestManager
}
