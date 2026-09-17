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
 * request id to the agents holding it open (so a call that arrives with a
 * bare id finds a store), the transition listeners (the single feed for the
 * unified wire events), and the process-wide sweeps. Every store reports its
 * transitions here, which is what keeps the index current.
 *
 * An id can be open in more than one agent's store: a session cloned into
 * another agent replays the tool-use ids of its source. So every id-addressed
 * method takes the agent when the caller knows it — the persister always
 * does — and only that agent's store is consulted. A bare id is answered by
 * the agent that registered it first and still holds it, which is what the
 * one global store used to answer.
 *
 * The slug-addressed methods dispatch to that agent's store; the agent's
 * actor calls its store directly. A read for an agent that has no handle
 * finds nothing — no request can exist for it.
 */
export class UserInputRequestManager implements UserInputTransitionSink {
  private readonly agents = new AttachedStores<AgentInputRequests>('user-input requests')

  /** The agents holding each id open, in the order they registered it. */
  private ownersById = new Map<string, Set<AgentSlug>>()

  private transitionListeners = new Set<(transition: UserInputRequestTransition) => void>()

  /**
   * Called by the agent registry with the way to each agent's store. The
   * index is rebuilt from what the stores hold: a registry built over state
   * that outlived an earlier one (a dev-server reload) attaches stores with
   * requests already open, and those emit no second 'created' transition.
   * The stores are replayed in registration order, so the first registrant
   * of an id stays first however the handles were made.
   */
  attachAgents(directory: AgentStoreDirectory<AgentInputRequests> | null): void {
    this.agents.attach(directory)
    this.ownersById.clear()
    const registrations = this.agents
      .all()
      .flatMap((store) => store.openRegistrations().map(({ request, seq }) => ({ id: request.id, slug: store.slug, seq })))
      .sort((a, b) => a.seq - b.seq)
    for (const { id, slug } of registrations) this.indexOwner(id, slug)
  }

  private indexOwner(id: string, slug: AgentSlug): void {
    let owners = this.ownersById.get(id)
    if (!owners) {
      owners = new Set()
      this.ownersById.set(id, owners)
    }
    owners.add(slug)
  }

  /** A store's transition: index it, then fan it out. */
  report(transition: UserInputRequestTransition): void {
    const { id, scope } = transition.request
    const slug = scope.agentSlug
    if (slug !== undefined) {
      if (transition.type === 'created') {
        this.indexOwner(id, slug)
      } else {
        const owners = this.ownersById.get(id)
        owners?.delete(slug)
        if (owners?.size === 0) this.ownersById.delete(id)
      }
    }
    this.emitTransition(transition)
  }

  /**
   * The store an id-addressed call goes to: the named agent's, or for a bare
   * id the store of the agent that registered it first and still holds it.
   */
  private storeFor(id: string, agentSlug?: AgentSlug): AgentInputRequests | undefined {
    if (agentSlug !== undefined) return this.agents.peek(agentSlug)
    const [first] = this.ownersById.get(id) ?? []
    return first === undefined ? undefined : this.agents.peek(first)
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
  resolve(id: string, outcome: UserInputRequestOutcome, agentSlug?: AgentSlug): PendingUserInputRequest | null {
    return this.storeFor(id, agentSlug)?.resolve(id, outcome) ?? null
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

  /** `AgentInputRequests.resolveIfInStore` on the agent's store. */
  resolveIfInStore(
    id: string,
    store: UserInputRequestStore,
    outcome: UserInputRequestOutcome,
    agentSlug?: AgentSlug,
  ): PendingUserInputRequest | null {
    return this.storeFor(id, agentSlug)?.resolveIfInStore(id, store, outcome) ?? null
  }

  /** Mirror of the turn-boundary `pendingInputRequests.clear()` — stream store only. */
  clearSessionStreamRequests(agentSlug: string, sessionId: string, outcome: UserInputRequestOutcome): void {
    this.agents.peek(agentSlug)?.clearSessionStreamRequests(sessionId, outcome)
  }

  /**
   * Settle every open request registered under a parent Task tool_use — the
   * dead-subagent sweep. In the agent's store when named, else across every
   * agent. Returns what was settled.
   */
  resolveRequestsByParent(
    parentToolUseId: string,
    outcome: UserInputRequestOutcome = 'invalidated',
    agentSlug?: AgentSlug,
  ): PendingUserInputRequest[] {
    if (agentSlug !== undefined) {
      return this.agents.peek(agentSlug)?.resolveRequestsByParent(parentToolUseId, outcome) ?? []
    }
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

  /** Look up a single open request by id, in the agent's store when named. */
  getOpenRequest(id: string, agentSlug?: AgentSlug): PendingUserInputRequest | null {
    return this.storeFor(id, agentSlug)?.getOpenRequest(id) ?? null
  }

  /** `AgentInputRequests.enrichOpenRequestPayload` on the agent's store. */
  enrichOpenRequestPayload(
    id: string,
    kind: PendingUserInputRequest['kind'],
    enrichment: Record<string, unknown>,
    agentSlug?: AgentSlug,
  ): boolean {
    return this.storeFor(id, agentSlug)?.enrichOpenRequestPayload(id, kind, enrichment) ?? false
  }

  /** `AgentInputRequests.claimRequest` on the agent's store. */
  claimRequest(id: string, agentSlug?: AgentSlug): PendingUserInputRequest | null {
    return this.storeFor(id, agentSlug)?.claimRequest(id) ?? null
  }

  /** Drop a claim. No-op for an id that already settled. */
  releaseClaim(id: string, agentSlug?: AgentSlug): void {
    this.storeFor(id, agentSlug)?.releaseClaim(id)
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
    this.ownersById.clear()
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
