/**
 * Retry Utilities
 *
 * Helper functions for retrying operations with exponential backoff.
 */

// Throw from inside withRetry to skip backoff on deterministic 4xx. `status` carries the HTTP status
// so a caller can map a specific code to actionable copy without re-parsing the message.
export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'NonRetryableError'
  }
}

// Exponential backoff; NonRetryableError bypasses retry. Default: 3 attempts, 1s/2s waits.
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (error instanceof NonRetryableError) throw error
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}
