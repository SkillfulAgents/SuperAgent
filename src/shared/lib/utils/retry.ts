/**
 * Retry Utilities
 *
 * Helper functions for retrying operations with exponential backoff.
 */

/**
 * Retry a function with exponential backoff
 *
 * @param fn - The async function to retry
 * @param maxRetries - Maximum number of attempts (default: 3)
 * @param baseDelayMs - Initial delay in milliseconds (default: 1000)
 * @returns The result of the function
 * @throws The last error if all retries fail
 *
 * @example
 * const result = await withRetry(() => fetchData(), 3, 1000)
 * // Attempts: immediate, then 1s delay, then 2s delay
 */
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
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}
