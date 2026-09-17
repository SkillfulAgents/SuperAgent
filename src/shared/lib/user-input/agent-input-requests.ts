import type { AgentSlug } from '@shared/lib/agent-actor/types'
import {
  pendingUserInputRequestSchema,
  storeForKind,
  type PendingUserInputRequest,
  type PendingUserInputRequestInput,
  type UserInputRequestOutcome,
  type UserInputRequestScope,
  type UserInputRequestStore,
} from './request-schema'

/**
 * One agent's pending user-input requests — THE pending store for that
 * agent. There is no second one.
 *
 * Owned by the agent's actor, created with it and released with it, so
 * nothing here can outlive the agent or belong to another one: every request
 * in this store was registered under this agent's slug, and a lookup by
 * session id can only ever find this agent's sessions (a session id is unique
 * only within an agent — an import or a clone gives each agent its own copy,
 * and with it the source's tool-use ids, so the same request id can be open
 * here and in another agent's store at once).
 *
 * Everything downstream derives from the store: the session "awaiting input"
 * status (`isSessionAwaiting` — the persister's bit is an edge-detection
 * cache of that projection), the unified wire events, the snapshot endpoint,
 * OS notifications, and the decision routes' already-settled gate. The
 * process-wide `userInputRequestManager` is the router in front of every
 * agent's store: it indexes ids to owners and fans transitions out.
 */

/**
 * A store transition: exactly one 'created' per accepted registration and
 * one 'resolved' per settlement, no matter which of the many mutation paths
 * drove it. This is the single feed for the unified wire events
 * (user_request_created / user_request_resolved) — emitting from here instead
 * of per-callsite is what makes silent-exit bugs structurally impossible.
 */
export interface UserInputRequestTransition {
  type: 'created' | 'resolved'
  request: PendingUserInputRequest
  outcome?: UserInputRequestOutcome
}

/**
 * A settled request as the bounded resolution trail remembers it: enough
 * identity (kind + scope) to re-run the same authorization checks an open
 * request gets, plus how it settled.
 */
export interface SettledUserInputRequest {
  id: string
  kind: PendingUserInputRequest['kind']
  scope: UserInputRequestScope
  outcome: UserInputRequestOutcome
}

/** Where a store reports its transitions: the router, which indexes and fans them out. */
export interface UserInputTransitionSink {
  report(transition: UserInputRequestTransition): void
}

/** How many settlements an agent's resolution trail remembers. */
export const RECENT_RESOLUTIONS_LIMIT = 100

/**
 * Orders registrations and settlements across every agent's store: a
 * process-wide clock, not state — the router asks the stores which of them
 * registered an id first and which settled it last. Kept on `globalThis` in
 * development, like the stores it orders, so a module reload does not
 * restart it under stores that survived the reload.
 */
const globalForSequence = globalThis as unknown as { userInputRequestSequence: { next: number } | undefined }
const sequence = globalForSequence.userInputRequestSequence ?? { next: 0 }
if (process.env.NODE_ENV !== 'production') {
  globalForSequence.userInputRequestSequence = sequence
}
const nextSeq = (): number => sequence.next++

/** A settlement as the trail holds it: the record, and its place in the process-wide order. */
export interface SettlementEntry {
  record: SettledUserInputRequest
  seq: number
}

/** An open request and its place in the process-wide registration order. */
export interface RegistrationEntry {
  request: PendingUserInputRequest
  seq: number
}

export class AgentInputRequests {
  private requests = new Map<string, PendingUserInputRequest>()

  /**
   * When each open request was first registered, in the process-wide order.
   * An upgrade of a recovered synthetic keeps the stub's place: it is the
   * same request, announced properly the second time.
   */
  private registeredAt = new Map<string, number>()

  /**
   * Bounded trail of recent settlements, for shadow-mode debugging and tests.
   * Carries kind AND scope, not just the outcome: the decision routes' gate
   * validates a settled request exactly like an open one, so a settled id must
   * stay as tightly bound to its route as it was while open — otherwise the
   * moment a request settles, its outcome becomes readable through any agent's
   * route of any kind.
   */
  private recentResolutions: SettlementEntry[] = []

  /**
   * Ids reserved by an in-flight decision.
   *
   * A claim is NOT a settlement: the request stays open to every reader — the
   * awaiting projection, the snapshot, the wire — because if the claimer fails
   * before settling, a human is still waiting on it. All a claim does is make
   * the DECISION path single-entry.
   */
  private claimed = new Set<string>()

  private mismatchCount = 0

  constructor(
    readonly slug: AgentSlug,
    private readonly sink: UserInputTransitionSink,
  ) {}

  /**
   * Register a pending request under this agent, whatever `scope.agentSlug`
   * the caller wrote. First delivery wins: re-registering an id that is still
   * open returns the original entry unchanged (stream stop and
   * complete-assistant can both carry the same tool_use).
   *
   * One exception: a real registration REPLACES a recovered synthetic for the
   * same id. Transcript recovery can synthesize a payload-less stub before the
   * stream event lands; the stub's 'created' transition is filtered off the
   * wire, so the upgrade emits 'created' again — the first renderable event
   * clients get for the id. A recovered input never replaces anything.
   *
   * Never throws — a malformed envelope is logged and dropped so shadow-mode
   * registration can never break a production delivery path.
   */
  register(input: PendingUserInputRequestInput): PendingUserInputRequest | null {
    const existing = this.requests.get(input.id)
    if (existing && !AgentInputRequests.isRecoveredSynthetic(existing)) return existing
    const parsed = pendingUserInputRequestSchema.safeParse({
      ...input,
      scope: { ...input.scope, agentSlug: this.slug },
    })
    if (!parsed.success) {
      if (existing) return existing
      console.error(
        `[AgentInputRequests] Dropped malformed request registration (agent=${this.slug}, id=${input.id}):`,
        parsed.error.message,
      )
      return null
    }
    if (existing && AgentInputRequests.isRecoveredSynthetic(parsed.data)) return existing
    this.requests.set(parsed.data.id, parsed.data)
    if (!this.registeredAt.has(parsed.data.id)) this.registeredAt.set(parsed.data.id, nextSeq())
    this.emitTransition({ type: 'created', request: parsed.data })
    return parsed.data
  }

  private static isRecoveredSynthetic(request: PendingUserInputRequest): boolean {
    return (request.payload as Record<string, unknown>).recovered === true
  }

  /** Settle and remove a request. Idempotent: unknown ids are a no-op (null). */
  resolve(id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null {
    const request = this.requests.get(id)
    if (!request) return null
    this.requests.delete(id)
    this.registeredAt.delete(id)
    // The claim dies with the entry: a settled id must never leave a
    // reservation behind that a re-registration under the same toolUseId
    // would inherit.
    this.claimed.delete(id)
    this.recentResolutions.push({
      record: { id, kind: request.kind, scope: request.scope, outcome },
      seq: nextSeq(),
    })
    if (this.recentResolutions.length > RECENT_RESOLUTIONS_LIMIT) this.recentResolutions.shift()
    this.emitTransition({ type: 'resolved', request, outcome })
    return request
  }

  private emitTransition(transition: UserInputRequestTransition): void {
    try {
      this.sink.report(transition)
    } catch (error) {
      console.error('[AgentInputRequests] transition sink failed:', error)
    }
  }

  /**
   * Settle a request only if it lives on the given legacy store. Mirrors
   * store-scoped deletes exactly: a main-path tool_result deletes blindly from
   * the stream store, and must not evict a computer-use or review entry that
   * its own store still holds.
   */
  resolveIfInStore(
    id: string,
    store: UserInputRequestStore,
    outcome: UserInputRequestOutcome,
  ): PendingUserInputRequest | null {
    const request = this.requests.get(id)
    if (!request || storeForKind(request.kind) !== store) return null
    return this.resolve(id, outcome)
  }

  /**
   * A request scoped to exactly this session. Agent-scoped requests (no
   * sessionId) never match a session.
   */
  private isForSession(request: PendingUserInputRequest, sessionId: string): boolean {
    return request.scope.sessionId === sessionId
  }

  /** Mirror of the turn-boundary `pendingInputRequests.clear()` — stream store only. */
  clearSessionStreamRequests(sessionId: string, outcome: UserInputRequestOutcome): void {
    for (const request of [...this.requests.values()]) {
      if (!this.isForSession(request, sessionId)) continue
      if (storeForKind(request.kind) !== 'stream') continue
      this.resolve(request.id, outcome)
    }
  }

  /**
   * Settle every open request registered under a parent Task tool_use — the
   * dead-subagent sweep. Returns what was settled so the caller can clean up
   * its mirrors (replay store, container pendings).
   */
  resolveRequestsByParent(
    parentToolUseId: string,
    outcome: UserInputRequestOutcome = 'invalidated',
  ): PendingUserInputRequest[] {
    const settled: PendingUserInputRequest[] = []
    for (const request of [...this.requests.values()]) {
      if (request.parentToolUseId !== parentToolUseId) continue
      const resolved = this.resolve(request.id, outcome)
      if (resolved) settled.push(resolved)
    }
    return settled
  }

  /** Mirror of `streamingStates.delete` — every session-scoped entry dies with the state. */
  dropSessionRequests(sessionId: string, outcome: UserInputRequestOutcome = 'invalidated'): void {
    for (const request of [...this.requests.values()]) {
      if (!this.isForSession(request, sessionId)) continue
      this.resolve(request.id, outcome)
    }
  }

  /** Look up a single open request by id. */
  getOpenRequest(id: string): PendingUserInputRequest | null {
    return this.requests.get(id) ?? null
  }

  /**
   * Add host-derived context to an open request without treating it as a new
   * request. The original created transition has already rendered the card;
   * enrichments are server-side context used by later privileged actions.
   */
  enrichOpenRequestPayload(
    id: string,
    kind: PendingUserInputRequest['kind'],
    enrichment: Record<string, unknown>,
  ): boolean {
    const request = this.requests.get(id)
    if (!request || request.kind !== kind) return false
    Object.assign(request.payload, enrichment)
    return true
  }

  /**
   * Reserve an open request for settlement, returning it to the FIRST caller
   * only. A plain `getOpenRequest` before a decision is check-then-act: the
   * decision path awaits (container lookup, the resolve call itself) between
   * observing the request and settling it, so a second decider observes the
   * same open request and both act. This is a synchronous check-and-mark with
   * no await inside, which on node's single thread makes it atomic — the
   * loser gets null and can report the decision as already handled.
   *
   * The caller MUST `releaseClaim` on every path that does NOT settle the
   * request, or it stays open and permanently undecidable. `resolve` drops the
   * claim with the entry, so the success path needs no explicit release.
   */
  claimRequest(id: string): PendingUserInputRequest | null {
    const request = this.requests.get(id)
    if (!request || this.claimed.has(id)) return null
    this.claimed.add(id)
    return request
  }

  /** Drop a claim. No-op for an id that already settled. */
  releaseClaim(id: string): void {
    this.claimed.delete(id)
  }

  /**
   * How a request settled, while it is still on the bounded resolution trail.
   * Lets an already-settled decision answer with what actually happened
   * instead of a bare "already settled" — but the caller must first check the
   * returned kind against the route it arrived on, exactly as it would for an
   * open request. Once the trail rotates the record out, the id is
   * indistinguishable from one that never existed.
   */
  getRecentResolution(id: string): SettledUserInputRequest | undefined {
    return this.recentSettlement(id)?.record
  }

  /** The whole trail, oldest first. */
  recentSettlements(): SettlementEntry[] {
    return [...this.recentResolutions]
  }

  /** The trail's newest settlement of an id, with its place in the process-wide order. */
  recentSettlement(id: string): SettlementEntry | undefined {
    for (let i = this.recentResolutions.length - 1; i >= 0; i--) {
      if (this.recentResolutions[i].record.id === id) return this.recentResolutions[i]
    }
    return undefined
  }

  getOpenRequestsForSession(sessionId: string): PendingUserInputRequest[] {
    return [...this.requests.values()].filter((r) => this.isForSession(r, sessionId))
  }

  /** Every open request of a legacy store (e.g. shutdown sweeps). */
  getOpenRequestsForStore(store: UserInputRequestStore): PendingUserInputRequest[] {
    return [...this.requests.values()].filter((r) => storeForKind(r.kind) === store)
  }

  /** Session-scoped AND agent-scoped entries. */
  getOpenRequests(): PendingUserInputRequest[] {
    return [...this.requests.values()]
  }

  /** Every open request with its place in the process-wide registration order. */
  openRegistrations(): RegistrationEntry[] {
    return [...this.requests.values()].map((request) => ({
      request,
      seq: this.registeredAt.get(request.id) ?? Number.MAX_SAFE_INTEGER,
    }))
  }

  /** Agent-scoped only (no sessionId) — reviews and re-auth requests. */
  getAgentScopedRequests(): PendingUserInputRequest[] {
    return [...this.requests.values()].filter((r) => r.scope.sessionId === undefined)
  }

  /**
   * Wire snapshot for a scope. A session's view is its own requests plus the
   * agent-scoped requests (a parked review blocks — and renders in — every
   * session of the agent); the agent's view is everything. Recovery
   * synthetics are INCLUDED: they are real blocking waits and the snapshot is
   * the clients' awaiting-status source — excluding them made the activity
   * indicator read "Working…" against a visible recovered card. They carry no
   * renderable payload, so the per-kind card guards drop them (the transcript
   * renders the card); only the wire EVENTS filter them.
   */
  getSnapshotForScope(sessionId?: string): PendingUserInputRequest[] {
    if (sessionId === undefined) return this.getOpenRequests()
    return [...this.requests.values()].filter(
      (r) => r.scope.sessionId === sessionId || r.scope.sessionId === undefined,
    )
  }

  getStoreIdsForSession(sessionId: string, store: UserInputRequestStore): string[] {
    return [...this.requests.values()]
      .filter((r) => this.isForSession(r, sessionId) && storeForKind(r.kind) === store)
      .map((r) => r.id)
  }

  private isRealWait(request: PendingUserInputRequest): boolean {
    return request.blocking && !request.autoApproved
  }

  /**
   * Derived awaiting projection for a session: any open real wait scoped to
   * the session, plus any agent-scoped real wait (a parked review blocks every
   * session of the agent). This is the source of truth for "awaiting input" —
   * the persister recomputes it after every transition and broadcasts on the
   * edges.
   */
  isSessionAwaiting(sessionId: string): boolean {
    for (const request of this.requests.values()) {
      if (!this.isRealWait(request)) continue
      if (this.isForSession(request, sessionId) || request.scope.sessionId === undefined) return true
    }
    return false
  }

  isAwaiting(): boolean {
    for (const request of this.requests.values()) {
      if (this.isRealWait(request)) return true
    }
    return false
  }

  private reportMismatch(scope: string, context: string, mismatches: string[]): void {
    this.mismatchCount++
    const message =
      `[AgentInputRequests] shadow mismatch (${scope}, agent=${this.slug}, ` +
      `context=${context}): ${mismatches.join('; ')}`
    if (process.env.VITEST) throw new Error(message)
    console.error(message)
  }

  /**
   * Review-side invariant, one-directional: every promise settler the agent's
   * reviews hold must correspond to an open review-store entry — a settler
   * without one is a parked proxied call no sweep can ever reach (the
   * silent-exit bug class). The converse is NOT an invariant: entries without
   * settlers are legitimate (feeders other than `request` own no promise).
   */
  verifyReviewSettlerParity(check: { context: string; settlerIds: string[] }): void {
    const registryIds = new Set(this.getOpenRequestsForStore('review').map((r) => r.id))
    const orphans = check.settlerIds.filter((id) => !registryIds.has(id))
    if (orphans.length === 0) return
    this.reportMismatch('review-settlers', check.context, [
      `orphaned settlers=[${[...orphans].sort().join(',')}]`,
    ])
  }

  get stats(): {
    open: number
    /** In-flight decision reservations. A non-zero idle value is a leaked claim. */
    claimed: number
    mismatches: number
    recentResolutions: SettledUserInputRequest[]
  } {
    return {
      open: this.requests.size,
      claimed: this.claimed.size,
      mismatches: this.mismatchCount,
      recentResolutions: this.recentResolutions.map((entry) => entry.record),
    }
  }

  /**
   * The agent is being dropped: settle every open request so its listeners
   * hear the end of it, then forget everything.
   */
  dispose(outcome: UserInputRequestOutcome = 'invalidated'): void {
    for (const id of [...this.requests.keys()]) this.resolve(id, outcome)
    this.reset()
  }

  /** Test hook: wipe all state including diagnostics, silently. */
  reset(): void {
    this.requests.clear()
    this.registeredAt.clear()
    this.claimed.clear()
    this.recentResolutions = []
    this.mismatchCount = 0
  }
}
