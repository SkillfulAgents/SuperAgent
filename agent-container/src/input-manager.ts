/**
 * Input Manager - Manages pending user input requests
 *
 * When a tool needs user input (like request_secret or AskUserQuestion), it creates a pending
 * promise that blocks until the user provides or declines the input.
 * The server can then resolve or reject the promise via HTTP endpoints.
 *
 * The toolUseId is captured via a PreToolUse hook before the tool executes,
 * then used by the tool handler to key the pending request.
 */

// Value types supported by the input manager
type InputValue = string | string[] | Record<string, string>

interface PendingInput<T extends InputValue = string> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  inputType: string // 'secret' | 'question' | 'connected_account'
  metadata?: unknown // questions array, secretName, toolkit, etc.
  createdAt: Date
  // Owning session, when known — lets deleteSession reject the session's
  // abandoned requests instead of leaving them (and the tool-handler closures
  // they retain) in the map forever.
  sessionId?: string
}

// Buffered result for when resolve/reject arrives before createPending
type EarlyResult =
  | { type: 'resolve'; value: InputValue; createdAt: Date }
  | { type: 'reject'; error: string; createdAt: Date }

// Input types the HOST answers programmatically (message-persister handlers
// hitting the DB/scheduler) — normally within milliseconds. An entry this old
// means the host handler died mid-request; nobody is coming back for it.
const AUTOMATED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'schedule_task',
  'schedule_resume',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  'pause_scheduled_task',
  'resume_scheduled_task',
  'create_webhook_endpoint',
  'update_webhook_endpoint',
  'inspect_webhook_events',
  'list_triggers',
  'get_available_triggers',
  'setup_trigger',
  'cancel_trigger',
])
export const AUTOMATED_INPUT_TTL_MS = 10 * 60 * 1000

// Everything else waits on a human decision (secrets, questions, script/file
// approvals, browser takeover). Generous by design — an overnight answer must
// still land — and the fail-safe default for unknown future types: worst case
// is a 24h-bounded entry, never a prematurely rejected human prompt.
export const HUMAN_INPUT_TTL_MS = 24 * 60 * 60 * 1000

// Early results only bridge the answer-before-createPending race, which is
// millisecond-scale (parallel tool calls). Anything older is an answer to a
// request whose handler never registered (e.g. the query was interrupted) —
// and since the buffer can hold secret values, it must not sit in memory.
export const EARLY_RESULT_TTL_MS = 5 * 60 * 1000

class InputManager {
  // Pending requests keyed by toolUseId
  private pending: Map<string, PendingInput<InputValue>> = new Map()

  // Buffered results for resolve/reject calls that arrive before createPending.
  // This handles the race condition where the UI responds to a tool call before
  // the tool handler has registered its pending entry (e.g. parallel tool calls
  // where the user answers the second one before its handler has started).
  private earlyResults: Map<string, EarlyResult> = new Map()

  // Current toolUseId captured by the PreToolUse hook
  // The hook sets this before the tool handler runs
  private currentToolUseId: string | null = null

  // Session attribution recorded at hook time, consumed when the matching
  // createPending* runs. Keyed by toolUseId (not a single slot) so two
  // sessions' interleaved tool calls can't cross-tag each other. Bounded
  // FIFO: a hook can fire for a call whose handler never registers a pending
  // (validation early-returns), so stragglers are possible but capped.
  private sessionIdByToolUse: Map<string, string> = new Map()
  private static readonly SESSION_TAG_CAP = 200

  /**
   * Set the current tool use ID (called by PreToolUse hook / canUseTool).
   * Pass the owning sessionId when known so the eventual pending entry can be
   * rejected if that session is deleted.
   */
  setCurrentToolUseId(toolUseId: string, sessionId?: string): void {
    this.currentToolUseId = toolUseId
    if (sessionId) {
      this.sessionIdByToolUse.set(toolUseId, sessionId)
      while (this.sessionIdByToolUse.size > InputManager.SESSION_TAG_CAP) {
        const oldest = this.sessionIdByToolUse.keys().next().value
        if (oldest === undefined) break
        this.sessionIdByToolUse.delete(oldest)
      }
    }
    console.log(`[InputManager] Set current toolUseId: ${toolUseId}`)
  }

  /** Get and clear the session recorded for a toolUseId at hook time. */
  private takeSessionIdFor(toolUseId: string): string | undefined {
    const sessionId = this.sessionIdByToolUse.get(toolUseId)
    this.sessionIdByToolUse.delete(toolUseId)
    return sessionId
  }

  /**
   * Get and clear the current tool use ID (called by tool handler)
   */
  consumeCurrentToolUseId(): string | null {
    const id = this.currentToolUseId
    this.currentToolUseId = null
    return id
  }

  /**
   * Create a pending input request that blocks until resolved or rejected (backward compatible).
   * @param toolUseId - The tool_use_id from the Claude SDK (captured via hook)
   * @param secretName - The environment variable name for the secret
   * @param reason - Optional reason why the secret is needed
   * @returns Promise that resolves with the secret value or rejects with an error
   */
  createPending(
    toolUseId: string,
    secretName: string,
    reason?: string
  ): Promise<string> {
    return this.createPendingWithType<string>(toolUseId, 'secret', {
      secretName,
      reason,
    })
  }

  /**
   * Create a pending input request with a specific value type.
   * @param toolUseId - The tool_use_id from the Claude SDK (captured via hook)
   * @param inputType - The type of input ('secret' | 'question' | 'connected_account')
   * @param metadata - Optional metadata (questions array, secretName, toolkit, etc.)
   * @returns Promise that resolves with the value or rejects with an error
   */
  createPendingWithType<T extends InputValue>(
    toolUseId: string,
    inputType: string,
    metadata?: unknown,
    sessionId?: string
  ): Promise<T> {
    // Session attribution: explicit param wins, else whatever the hook
    // recorded for this toolUseId. Consume the tag either way.
    const owner = sessionId ?? this.takeSessionIdFor(toolUseId)

    // Check if the user already responded before this pending was created
    const early = this.earlyResults.get(toolUseId)
    if (early) {
      this.earlyResults.delete(toolUseId)
      if (early.type === 'resolve') {
        console.log(
          `[InputManager] Immediately resolving ${inputType} request ${toolUseId} (early result)`
        )
        return Promise.resolve(early.value as T)
      } else {
        console.log(
          `[InputManager] Immediately rejecting ${inputType} request ${toolUseId} (early result): ${early.error}`
        )
        return Promise.reject(new Error(early.error))
      }
    }

    return new Promise((resolve, reject) => {
      this.pending.set(toolUseId, {
        resolve: resolve as (value: InputValue) => void,
        reject,
        inputType,
        metadata,
        createdAt: new Date(),
        sessionId: owner,
      })

      console.log(
        `[InputManager] Created pending ${inputType} request ${toolUseId}${owner ? ` (session ${owner})` : ''}`
      )
    })
  }

  /**
   * Reject and remove every pending request owned by a session. Called when
   * the session is deleted — the host will never answer them, and each entry
   * pins its tool-handler closure (and the dead query context) in memory. A
   * still-live awaiter gets a clean error instead of a permanent hang.
   * @returns number of requests rejected
   */
  rejectForSession(sessionId: string, reason = 'Input request abandoned: the session was deleted'): number {
    let rejected = 0
    for (const [toolUseId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue
      console.log(
        `[InputManager] Rejecting ${pending.inputType} request ${toolUseId} (session ${sessionId} deleted)`
      )
      this.pending.delete(toolUseId)
      pending.reject(new Error(reason))
      rejected++
    }
    return rejected
  }

  /**
   * Reject and remove every pending request of a given input type. Used for
   * lifecycle invalidation: a request can become unanswerable when the
   * resource it depends on goes away — e.g. browser_input requests when the
   * browser closes (possibly by a DIFFERENT session or agent than the one
   * that created the request, so per-session scoping is not enough here).
   * A blocked awaiter gets a clean error and can continue its turn instead
   * of parking until the 24h human-input TTL.
   * @returns number of requests rejected
   */
  rejectByType(inputType: string, reason: string): number {
    let rejected = 0
    for (const [toolUseId, pending] of this.pending) {
      if (pending.inputType !== inputType) continue
      console.log(
        `[InputManager] Rejecting ${pending.inputType} request ${toolUseId} (type invalidated): ${reason}`
      )
      this.pending.delete(toolUseId)
      pending.reject(new Error(reason))
      rejected++
    }
    return rejected
  }

  /**
   * Resolve a pending request with a value.
   * If no pending request exists yet (e.g. parallel tool calls race condition),
   * the value is buffered so createPending can resolve immediately when called.
   * @param toolUseId - The tool_use_id to resolve
   * @param value - The value provided by the user (string, string[] or Record<string, string>)
   * @returns true (always succeeds — either resolves immediately or buffers)
   */
  resolve(toolUseId: string, value: InputValue): boolean {
    const pending = this.pending.get(toolUseId)
    if (!pending) {
      // The tool handler hasn't called createPending yet (race condition with
      // parallel tool calls). Buffer the value so createPending can resolve
      // immediately when it runs.
      console.log(
        `[InputManager] No pending request found for ${toolUseId}, buffering early resolve`
      )
      this.earlyResults.set(toolUseId, { type: 'resolve', value, createdAt: new Date() })
      return true
    }

    console.log(
      `[InputManager] Resolving ${pending.inputType} request ${toolUseId}`
    )
    this.pending.delete(toolUseId)
    pending.resolve(value)
    return true
  }

  /**
   * Reject a pending request with an error.
   * If no pending request exists yet (e.g. parallel tool calls race condition),
   * the rejection is buffered so createPending can reject immediately when called.
   * @param toolUseId - The tool_use_id to reject
   * @param error - Error message describing why the request was rejected
   * @returns true (always succeeds — either rejects immediately or buffers)
   */
  reject(toolUseId: string, error: string): boolean {
    const pending = this.pending.get(toolUseId)
    if (!pending) {
      // The tool handler hasn't called createPending yet (race condition with
      // parallel tool calls). Buffer the rejection so createPending can reject
      // immediately when it runs.
      console.log(
        `[InputManager] No pending request found for ${toolUseId}, buffering early reject`
      )
      this.earlyResults.set(toolUseId, { type: 'reject', error, createdAt: new Date() })
      return true
    }

    console.log(
      `[InputManager] Rejecting ${pending.inputType} request ${toolUseId}: ${error}`
    )
    this.pending.delete(toolUseId)
    pending.reject(new Error(error))
    return true
  }

  /**
   * Check if a request is pending.
   * @param toolUseId - The tool_use_id to check
   * @returns true if the request is pending, false otherwise
   */
  hasPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId)
  }

  /**
   * Get all pending requests (useful for debugging).
   */
  getAllPending(): Array<{
    toolUseId: string
    inputType: string
    metadata?: unknown
    createdAt: Date
    sessionId?: string
  }> {
    return Array.from(this.pending.entries()).map(([toolUseId, pending]) => ({
      toolUseId,
      inputType: pending.inputType,
      metadata: pending.metadata,
      createdAt: pending.createdAt,
      sessionId: pending.sessionId,
    }))
  }

  /**
   * Reject pending requests past their type's TTL and drop expired early
   * results. Run periodically (the server wires a 60s sweep) — without it,
   * entries the host never answers live forever.
   */
  cleanupStale(nowMs: number = Date.now()): void {
    for (const [toolUseId, pending] of this.pending) {
      const ttlMs = AUTOMATED_INPUT_TYPES.has(pending.inputType)
        ? AUTOMATED_INPUT_TTL_MS
        : HUMAN_INPUT_TTL_MS
      if (nowMs - pending.createdAt.getTime() > ttlMs) {
        console.log(
          `[InputManager] Cleaning up stale ${pending.inputType} request ${toolUseId}`
        )
        this.pending.delete(toolUseId)
        pending.reject(new Error('Input request timed out'))
      }
    }
    for (const [toolUseId, early] of this.earlyResults) {
      if (nowMs - early.createdAt.getTime() > EARLY_RESULT_TTL_MS) {
        console.log(`[InputManager] Dropping expired early result for ${toolUseId}`)
        this.earlyResults.delete(toolUseId)
      }
    }
  }
}

// Export singleton instance
export const inputManager = new InputManager()
