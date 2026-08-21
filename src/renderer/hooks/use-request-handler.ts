/**
 * useRequestHandler — shared state management for request item components
 * (secret requests, file requests, question requests, etc.)
 *
 * Manages the common pending → submitting → completed/declined flow
 * with error handling and status reset on failure.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { captureRendererException } from '@renderer/lib/error-reporting'

export const REQUEST_SUBMIT_TIMEOUT_MS = 15_000
export const REQUEST_SUBMIT_TIMEOUT_MESSAGE = 'Request timed out. Please try again.'

interface UseRequestHandlerOptions {
  timeoutMs?: number
}

class RequestTimeoutError extends Error {
  constructor() {
    super(REQUEST_SUBMIT_TIMEOUT_MESSAGE)
    this.name = 'RequestTimeoutError'
  }
}

export function useRequestHandler(
  onComplete: () => void,
  { timeoutMs = REQUEST_SUBMIT_TIMEOUT_MS }: UseRequestHandlerOptions = {},
) {
  const [status, setStatus] = useState<string>('pending')
  const [error, setError] = useState<string | null>(null)
  const attemptRef = useRef(0)
  const activeControllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    attemptRef.current += 1
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
  }, [])

  /**
   * Execute an async action with automatic status transitions:
   *   pending → submitting → successStatus (on success)
   *   pending → submitting → pending (on failure, with error set)
   */
  const submit = useCallback(async (
    fn: (signal: AbortSignal) => Promise<void>,
    successStatus: string,
  ) => {
    const attempt = ++attemptRef.current
    activeControllerRef.current?.abort()
    const controller = new AbortController()
    activeControllerRef.current = controller

    setStatus('submitting')
    setError(null)
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.race([
        Promise.resolve().then(() => fn(controller.signal)),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort()
            reject(new RequestTimeoutError())
          }, timeoutMs)
        }),
      ])
      if (attempt !== attemptRef.current) return
      setStatus(successStatus)
      onComplete()
    } catch (err: unknown) {
      if (attempt !== attemptRef.current) return
      captureRendererException(err, { tags: { source: 'request-item' } })
      setError(err instanceof Error ? err.message : 'Request failed')
      setStatus('pending')
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      if (activeControllerRef.current === controller) {
        activeControllerRef.current = null
      }
    }
  }, [onComplete, timeoutMs])

  return { status, error, submit, setStatus, setError }
}
