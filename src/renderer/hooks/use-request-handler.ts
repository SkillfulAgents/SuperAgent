/**
 * useRequestHandler — shared state management for request item components
 * (secret requests, file requests, question requests, etc.)
 *
 * Manages the common pending → submitting → completed/declined flow
 * with error handling and status reset on failure.
 */

import { useState, useCallback } from 'react'

export function useRequestHandler(onComplete: () => void) {
  const [status, setStatus] = useState<string>('pending')
  const [error, setError] = useState<string | null>(null)

  /**
   * Execute an async action with automatic status transitions:
   *   pending → submitting → successStatus (on success)
   *   pending → submitting → pending (on failure, with error set)
   */
  const submit = useCallback(async (
    fn: () => Promise<void>,
    successStatus: string,
  ) => {
    setStatus('submitting')
    setError(null)
    try {
      await fn()
      setStatus(successStatus)
      onComplete()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed')
      setStatus('pending')
    }
  }, [onComplete])

  return { status, error, submit, setStatus, setError }
}
