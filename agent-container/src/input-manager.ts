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
type InputValue = string | Record<string, string>

interface PendingInput<T extends InputValue = string> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  inputType: string // 'secret' | 'question' | 'connected_account'
  metadata?: unknown // questions array, secretName, toolkit, etc.
  createdAt: Date
}

class InputManager {
  // Pending requests keyed by toolUseId
  private pending: Map<string, PendingInput<InputValue>> = new Map()

  // Current toolUseId captured by the PreToolUse hook
  // The hook sets this before the tool handler runs
  private currentToolUseId: string | null = null

  /**
   * Set the current tool use ID (called by PreToolUse hook)
   */
  setCurrentToolUseId(toolUseId: string): void {
    this.currentToolUseId = toolUseId
    console.log(`[InputManager] Set current toolUseId: ${toolUseId}`)
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
    return new Promise((resolve, reject) => {
      this.pending.set(toolUseId, {
        resolve: resolve as (value: InputValue) => void,
        reject,
        inputType: 'secret',
        metadata: { secretName, reason },
        createdAt: new Date(),
      })

      console.log(
        `[InputManager] Created pending request ${toolUseId} for secret ${secretName}`
      )
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
    metadata?: unknown
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.set(toolUseId, {
        resolve: resolve as (value: InputValue) => void,
        reject,
        inputType,
        metadata,
        createdAt: new Date(),
      })

      console.log(
        `[InputManager] Created pending ${inputType} request ${toolUseId}`
      )
    })
  }

  /**
   * Resolve a pending request with a value.
   * @param toolUseId - The tool_use_id to resolve
   * @param value - The value provided by the user (string or Record<string, string>)
   * @returns true if the request was found and resolved, false otherwise
   */
  resolve(toolUseId: string, value: InputValue): boolean {
    const pending = this.pending.get(toolUseId)
    if (!pending) {
      console.log(`[InputManager] No pending request found for ${toolUseId}`)
      return false
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
   * @param toolUseId - The tool_use_id to reject
   * @param error - Error message describing why the request was rejected
   * @returns true if the request was found and rejected, false otherwise
   */
  reject(toolUseId: string, error: string): boolean {
    const pending = this.pending.get(toolUseId)
    if (!pending) {
      console.log(`[InputManager] No pending request found for ${toolUseId}`)
      return false
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
  }> {
    return Array.from(this.pending.entries()).map(([toolUseId, pending]) => ({
      toolUseId,
      inputType: pending.inputType,
      metadata: pending.metadata,
      createdAt: pending.createdAt,
    }))
  }

  /**
   * Cleanup stale pending requests (optional timeout mechanism).
   * @param maxAgeMs - Maximum age in milliseconds before a request is considered stale
   */
  cleanupStale(maxAgeMs: number = 5 * 60 * 1000): void {
    const now = new Date()
    for (const [toolUseId, pending] of this.pending) {
      if (now.getTime() - pending.createdAt.getTime() > maxAgeMs) {
        console.log(
          `[InputManager] Cleaning up stale ${pending.inputType} request ${toolUseId}`
        )
        pending.reject(new Error('Input request timed out'))
        this.pending.delete(toolUseId)
      }
    }
  }
}

// Export singleton instance
export const inputManager = new InputManager()
