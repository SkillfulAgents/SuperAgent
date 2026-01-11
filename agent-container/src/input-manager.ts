/**
 * Input Manager - Manages pending user input requests
 *
 * When a tool needs user input (like request_secret), it creates a pending
 * promise that blocks until the user provides or declines the input.
 * The server can then resolve or reject the promise via HTTP endpoints.
 *
 * The toolUseId is captured via a PreToolUse hook before the tool executes,
 * then used by the tool handler to key the pending request.
 */

interface PendingInput {
  resolve: (value: string) => void
  reject: (error: Error) => void
  secretName: string
  reason?: string
  createdAt: Date
}

class InputManager {
  // Pending requests keyed by toolUseId
  private pending: Map<string, PendingInput> = new Map()

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
   * Create a pending input request that blocks until resolved or rejected.
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
        resolve,
        reject,
        secretName,
        reason,
        createdAt: new Date(),
      })

      console.log(
        `[InputManager] Created pending request ${toolUseId} for secret ${secretName}`
      )
    })
  }

  /**
   * Resolve a pending request with the secret value.
   * @param toolUseId - The tool_use_id to resolve
   * @param value - The secret value provided by the user
   * @returns true if the request was found and resolved, false otherwise
   */
  resolve(toolUseId: string, value: string): boolean {
    const pending = this.pending.get(toolUseId)
    if (!pending) {
      console.log(`[InputManager] No pending request found for ${toolUseId}`)
      return false
    }

    console.log(
      `[InputManager] Resolving request ${toolUseId} for secret ${pending.secretName}`
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
      `[InputManager] Rejecting request ${toolUseId} for secret ${pending.secretName}: ${error}`
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
    secretName: string
    reason?: string
    createdAt: Date
  }> {
    return Array.from(this.pending.entries()).map(([toolUseId, pending]) => ({
      toolUseId,
      secretName: pending.secretName,
      reason: pending.reason,
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
          `[InputManager] Cleaning up stale request ${toolUseId} for secret ${pending.secretName}`
        )
        pending.reject(new Error('Input request timed out'))
        this.pending.delete(toolUseId)
      }
    }
  }
}

// Export singleton instance
export const inputManager = new InputManager()
