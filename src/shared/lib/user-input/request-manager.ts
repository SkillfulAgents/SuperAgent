import {
  pendingUserInputRequestSchema,
  shelfForKind,
  type PendingUserInputRequest,
  type PendingUserInputRequestInput,
  type UserInputRequestOutcome,
  type UserInputRequestShelf,
} from './request-schema'

/**
 * Host-side registry of every pending user-input request, regardless of which
 * legacy store owns it (persister stream shelf, computer-use map, ReviewManager).
 *
 * Phase 2 — SHADOW MODE: the legacy shelves stay authoritative and every
 * mutation writes through to this registry; nothing reads it for behavior.
 * `verifyShelfParity` asserts the mirror is exact at every shelf mutation
 * (throws under vitest, logs otherwise), and `compareAwaitingProjection`
 * counts divergence between the imperative awaiting bit and the projection
 * this registry derives — the known split-brains Phase 3 replaces the bit
 * to fix.
 */
export class UserInputRequestManager {
  private requests = new Map<string, PendingUserInputRequest>()

  /** Bounded trail of recent settlements, for shadow-mode debugging and tests. */
  private recentResolutions: Array<{
    id: string
    kind: PendingUserInputRequest['kind']
    outcome: UserInputRequestOutcome
  }> = []

  private shelfMismatchCount = 0
  private awaitingDivergenceCount = 0
  // Sessions currently known-diverged, so we warn once per divergence episode
  // instead of on every mutation while it persists.
  private divergedSessions = new Set<string>()

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
    return parsed.data
  }

  /** Settle and remove a request. Idempotent: unknown ids are a no-op (null). */
  resolve(id: string, outcome: UserInputRequestOutcome): PendingUserInputRequest | null {
    const request = this.requests.get(id)
    if (!request) return null
    this.requests.delete(id)
    this.recentResolutions.push({ id, kind: request.kind, outcome })
    if (this.recentResolutions.length > 100) this.recentResolutions.shift()
    return request
  }

  /**
   * Settle a request only if it lives on the given legacy shelf. Mirrors
   * shelf-scoped deletes exactly: a main-path tool_result deletes blindly from
   * the stream shelf, and must not evict a computer-use or review entry that
   * its own store still holds.
   */
  resolveIfShelf(
    id: string,
    shelf: UserInputRequestShelf,
    outcome: UserInputRequestOutcome,
  ): PendingUserInputRequest | null {
    const request = this.requests.get(id)
    if (!request || shelfForKind(request.kind) !== shelf) return null
    return this.resolve(id, outcome)
  }

  /** Mirror of the turn-boundary `pendingInputRequests.clear()` — stream shelf only. */
  clearSessionStreamRequests(sessionId: string, outcome: UserInputRequestOutcome): void {
    for (const request of [...this.requests.values()]) {
      if (request.scope.sessionId !== sessionId) continue
      if (shelfForKind(request.kind) !== 'stream') continue
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

  getShelfIdsForSession(sessionId: string, shelf: UserInputRequestShelf): string[] {
    return [...this.requests.values()]
      .filter((r) => r.scope.sessionId === sessionId && shelfForKind(r.kind) === shelf)
      .map((r) => r.id)
  }

  private isRealWait(request: PendingUserInputRequest): boolean {
    return request.blocking && !request.autoApproved
  }

  /**
   * Derived awaiting projection for a session: any open real wait scoped to
   * the session, plus any agent-scoped real wait of its agent (a parked review
   * blocks every session of the agent — same semantics the imperative bit
   * approximates today). Phase 3 flips the persister onto this; Phase 2 only
   * compares it against the bit.
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
    shelfIds: string[],
    registryIds: string[],
  ): string | null {
    const expected = [...shelfIds].sort()
    const actual = [...registryIds].sort()
    if (expected.length === actual.length && expected.every((id, i) => id === actual[i])) {
      return null
    }
    return `${label}: shelf=[${expected.join(',')}] registry=[${actual.join(',')}]`
  }

  private reportShelfMismatch(scope: string, context: string, mismatches: string[]): void {
    this.shelfMismatchCount++
    const message =
      `[UserInputRequestManager] shadow shelf mismatch (${scope}, ` +
      `context=${context}): ${mismatches.join('; ')}`
    if (process.env.VITEST) throw new Error(message)
    console.error(message)
  }

  /**
   * Shadow invariant: the registry's per-shelf view of a session must equal the
   * legacy shelf exactly, at every shelf mutation point. Under vitest a
   * mismatch throws (mutation paths swallow errors in places, so tests should
   * ALSO assert `stats.shelfMismatches === 0`); in dev it logs.
   */
  verifyShelfParity(check: {
    sessionId: string
    context: string
    streamShelfIds: string[]
    computerUseShelfIds: string[]
  }): void {
    const mismatches = [
      UserInputRequestManager.describeIdMismatch(
        'stream',
        check.streamShelfIds,
        this.getShelfIdsForSession(check.sessionId, 'stream'),
      ),
      UserInputRequestManager.describeIdMismatch(
        'computer_use',
        check.computerUseShelfIds,
        this.getShelfIdsForSession(check.sessionId, 'computer_use'),
      ),
    ].filter((m): m is string => m !== null)
    if (mismatches.length === 0) return
    this.reportShelfMismatch(`session=${check.sessionId}`, check.context, mismatches)
  }

  /**
   * Same invariant for the review shelf: the registry's agent-scoped review
   * view must equal ReviewManager's pending store for the agent, at every
   * review mutation point.
   */
  verifyReviewShelfParity(check: {
    agentSlug: string
    context: string
    reviewShelfIds: string[]
  }): void {
    const registryIds = [...this.requests.values()]
      .filter(
        (r) =>
          r.scope.agentSlug === check.agentSlug &&
          r.scope.sessionId === undefined &&
          shelfForKind(r.kind) === 'review',
      )
      .map((r) => r.id)
    const mismatch = UserInputRequestManager.describeIdMismatch(
      'review',
      check.reviewShelfIds,
      registryIds,
    )
    if (mismatch === null) return
    this.reportShelfMismatch(`agent=${check.agentSlug}`, check.context, [mismatch])
  }

  /**
   * Soft comparison of the imperative awaiting bit vs the derived projection.
   * Never throws: the Phase 0 characterization suite pinned real split-brains
   * where the bit is wrong, and this counter is the telemetry that sizes them.
   * Warns once per divergence episode per session.
   */
  compareAwaitingProjection(check: {
    sessionId: string
    context: string
    agentSlug: string | undefined
    isAwaitingInput: boolean
  }): void {
    const projected = this.isSessionAwaiting(check.sessionId, check.agentSlug)
    if (projected === check.isAwaitingInput) {
      this.divergedSessions.delete(check.sessionId)
      return
    }
    this.awaitingDivergenceCount++
    if (this.divergedSessions.has(check.sessionId)) return
    this.divergedSessions.add(check.sessionId)
    console.warn(
      `[UserInputRequestManager] awaiting divergence (session=${check.sessionId}, ` +
        `context=${check.context}): bit=${check.isAwaitingInput} projection=${projected}`,
    )
  }

  get stats(): {
    open: number
    shelfMismatches: number
    awaitingDivergences: number
    recentResolutions: Array<{
      id: string
      kind: PendingUserInputRequest['kind']
      outcome: UserInputRequestOutcome
    }>
  } {
    return {
      open: this.requests.size,
      shelfMismatches: this.shelfMismatchCount,
      awaitingDivergences: this.awaitingDivergenceCount,
      recentResolutions: [...this.recentResolutions],
    }
  }

  /** Test hook: wipe all state including diagnostics. */
  reset(): void {
    this.requests.clear()
    this.recentResolutions = []
    this.shelfMismatchCount = 0
    this.awaitingDivergenceCount = 0
    this.divergedSessions.clear()
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
