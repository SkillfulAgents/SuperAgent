import {
  pendingUserInputRequestSchema,
  storeForKind,
  type PendingUserInputRequest,
  type PendingUserInputRequestInput,
  type UserInputRequestOutcome,
  type UserInputRequestStore,
} from './request-schema'

/**
 * Host-side registry of every pending user-input request, regardless of which
 * legacy store owns it (persister stream store, computer-use map, ReviewManager).
 *
 * Phase 3: the legacy stores stay authoritative for request CONTENTS (and
 * every mutation still writes through, with `verifyStoreParity` asserting the
 * mirror is exact), but the session "awaiting input" status is now DERIVED
 * from this registry via `isSessionAwaiting` — the persister's bit is just an
 * edge-detection cache of that projection. The imperative per-path mark/clear
 * calls (and their split-brains: parallel requests, direct-clear doors,
 * review blockers) are gone.
 */
/**
 * A registry transition: exactly one 'created' per accepted registration and
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

export class UserInputRequestManager {
  private requests = new Map<string, PendingUserInputRequest>()

  private transitionListeners = new Set<(transition: UserInputRequestTransition) => void>()

  /** Bounded trail of recent settlements, for shadow-mode debugging and tests. */
  private recentResolutions: Array<{
    id: string
    kind: PendingUserInputRequest['kind']
    outcome: UserInputRequestOutcome
  }> = []

  private storeMismatchCount = 0

  /**
   * Register a pending request. First delivery wins: re-registering an id that
   * is still open returns the original entry unchanged (stream stop and
   * complete-assistant can both carry the same tool_use).
   *
   * Never throws — a malformed envelope is logged and dropped so shadow-mode
   * registration can never break a production delivery path.
   */
  register(input: PendingUserInputRequestInput): PendingUserInputRequest | null {
    const existing = this.requests.get(input.id)
    if (existing) return existing
    const parsed = pendingUserInputRequestSchema.safeParse(input)
    if (!parsed.success) {
      console.error(
        `[UserInputRequestManager] Dropped malformed request registration (id=${input.id}):`,
        parsed.error.message,
      )
      return null
    }
    this.requests.set(parsed.data.id, parsed.data)
    this.emitTransition({ type: 'created', request: parsed.data })
    return parsed.data
  }

  /** Settle and remove a request. Idempotent: unknown ids are a no-op (null). */
  resolve(id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null {
    const request = this.requests.get(id)
    if (!request) return null
    this.requests.delete(id)
    this.recentResolutions.push({ id, kind: request.kind, outcome })
    if (this.recentResolutions.length > 100) this.recentResolutions.shift()
    this.emitTransition({ type: 'resolved', request, outcome })
    return request
  }

  /**
   * Subscribe to registry transitions. Listener errors are swallowed: wire
   * fan-out must never break the mutation path that triggered it.
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

  /** Mirror of the turn-boundary `pendingInputRequests.clear()` — stream store only. */
  clearSessionStreamRequests(sessionId: string, outcome: UserInputRequestOutcome): void {
    for (const request of [...this.requests.values()]) {
      if (request.scope.sessionId !== sessionId) continue
      if (storeForKind(request.kind) !== 'stream') continue
      this.resolve(request.id, outcome)
    }
  }

  /** Mirror of `streamingStates.delete` — every session-scoped entry dies with the state. */
  dropSessionRequests(sessionId: string, outcome: UserInputRequestOutcome = 'invalidated'): void {
    for (const request of [...this.requests.values()]) {
      if (request.scope.sessionId !== sessionId) continue
      this.resolve(request.id, outcome)
    }
  }

  getOpenRequestsForSession(sessionId: string): PendingUserInputRequest[] {
    return [...this.requests.values()].filter((r) => r.scope.sessionId === sessionId)
  }

  /** Session-scoped AND agent-scoped entries for the agent. */
  getOpenRequestsForAgent(agentSlug: string): PendingUserInputRequest[] {
    return [...this.requests.values()].filter((r) => r.scope.agentSlug === agentSlug)
  }

  /** Agent-scoped only (no sessionId) — today: proxy / x-agent reviews. */
  getAgentScopedRequests(agentSlug: string): PendingUserInputRequest[] {
    return [...this.requests.values()].filter(
      (r) => r.scope.agentSlug === agentSlug && r.scope.sessionId === undefined,
    )
  }

  /**
   * Wire snapshot for a scope. A session's view is its own requests plus the
   * agent-scoped requests of its agent (a parked review blocks — and renders
   * in — every session of the agent); an agent's view is everything in its
   * scope. Recovery synthetics are INCLUDED: they are real blocking waits and
   * the snapshot is the clients' awaiting-status source — excluding them made
   * the activity indicator read "Working…" against a visible recovered card.
   * They carry no renderable payload, so the per-kind card guards drop them
   * (the transcript renders the card); only the wire EVENTS filter them.
   */
  getSnapshotForScope(agentSlug: string, sessionId?: string): PendingUserInputRequest[] {
    return [...this.requests.values()].filter((r) => {
      // Agent check FIRST, unconditionally: sessionId arrives from an
      // unvalidated query param behind an AgentRead gate on the agent alone,
      // so matching on sessionId by itself would hand this agent's viewer
      // another agent's session-scoped payloads.
      if (r.scope.agentSlug !== agentSlug) return false
      if (sessionId !== undefined) {
        return r.scope.sessionId === sessionId || r.scope.sessionId === undefined
      }
      return true
    })
  }

  getStoreIdsForSession(sessionId: string, store: UserInputRequestStore): string[] {
    return [...this.requests.values()]
      .filter((r) => r.scope.sessionId === sessionId && storeForKind(r.kind) === store)
      .map((r) => r.id)
  }

  private isRealWait(request: PendingUserInputRequest): boolean {
    return request.blocking && !request.autoApproved
  }

  /**
   * Derived awaiting projection for a session: any open real wait scoped to
   * the session, plus any agent-scoped real wait of its agent (a parked review
   * blocks every session of the agent). This is the source of truth for
   * "awaiting input" — the persister recomputes it after every registry
   * transition and broadcasts on the edges.
   */
  isSessionAwaiting(sessionId: string, agentSlug?: string): boolean {
    for (const request of this.requests.values()) {
      if (!this.isRealWait(request)) continue
      if (request.scope.sessionId === sessionId) return true
      if (
        agentSlug !== undefined &&
        request.scope.sessionId === undefined &&
        request.scope.agentSlug === agentSlug
      ) {
        return true
      }
    }
    return false
  }

  isAgentAwaiting(agentSlug: string): boolean {
    for (const request of this.requests.values()) {
      if (this.isRealWait(request) && request.scope.agentSlug === agentSlug) return true
    }
    return false
  }

  private static describeIdMismatch(
    label: string,
    storeIds: string[],
    registryIds: string[],
  ): string | null {
    const expected = [...storeIds].sort()
    const actual = [...registryIds].sort()
    if (expected.length === actual.length && expected.every((id, i) => id === actual[i])) {
      return null
    }
    return `${label}: store=[${expected.join(',')}] registry=[${actual.join(',')}]`
  }

  private reportStoreMismatch(scope: string, context: string, mismatches: string[]): void {
    this.storeMismatchCount++
    const message =
      `[UserInputRequestManager] shadow store mismatch (${scope}, ` +
      `context=${context}): ${mismatches.join('; ')}`
    if (process.env.VITEST) throw new Error(message)
    console.error(message)
  }

  /**
   * Shadow invariant: the registry's per-store view of a session must equal the
   * legacy store exactly, at every store mutation point. Under vitest a
   * mismatch throws (mutation paths swallow errors in places, so tests should
   * ALSO assert `stats.storeMismatches === 0`); in dev it logs.
   */
  verifyStoreParity(check: {
    sessionId: string
    context: string
    streamStoreIds: string[]
    computerUseStoreIds: string[]
  }): void {
    const mismatches = [
      UserInputRequestManager.describeIdMismatch(
        'stream',
        check.streamStoreIds,
        this.getStoreIdsForSession(check.sessionId, 'stream'),
      ),
      UserInputRequestManager.describeIdMismatch(
        'computer_use',
        check.computerUseStoreIds,
        this.getStoreIdsForSession(check.sessionId, 'computer_use'),
      ),
    ].filter((m): m is string => m !== null)
    if (mismatches.length === 0) return
    this.reportStoreMismatch(`session=${check.sessionId}`, check.context, mismatches)
  }

  /**
   * Same invariant for the review store: the registry's agent-scoped review
   * view must equal ReviewManager's pending store for the agent, at every
   * review mutation point.
   */
  verifyReviewStoreParity(check: {
    agentSlug: string
    context: string
    reviewStoreIds: string[]
  }): void {
    const registryIds = [...this.requests.values()]
      .filter(
        (r) =>
          r.scope.agentSlug === check.agentSlug &&
          r.scope.sessionId === undefined &&
          storeForKind(r.kind) === 'review',
      )
      .map((r) => r.id)
    const mismatch = UserInputRequestManager.describeIdMismatch(
      'review',
      check.reviewStoreIds,
      registryIds,
    )
    if (mismatch === null) return
    this.reportStoreMismatch(`agent=${check.agentSlug}`, check.context, [mismatch])
  }

  get stats(): {
    open: number
    storeMismatches: number
    recentResolutions: Array<{
      id: string
      kind: PendingUserInputRequest['kind']
      outcome: UserInputRequestOutcome
    }>
  } {
    return {
      open: this.requests.size,
      storeMismatches: this.storeMismatchCount,
      recentResolutions: [...this.recentResolutions],
    }
  }

  /** Test hook: wipe all state including diagnostics. */
  reset(): void {
    this.requests.clear()
    this.recentResolutions = []
    this.storeMismatchCount = 0
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
