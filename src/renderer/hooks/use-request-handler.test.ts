// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { REQUEST_SUBMIT_TIMEOUT_MESSAGE, useRequestHandler } from './use-request-handler'

describe('useRequestHandler', () => {
  it('starts with pending status and no error', () => {
    const { result } = renderHook(() => useRequestHandler(vi.fn()))
    expect(result.current.status).toBe('pending')
    expect(result.current.error).toBeNull()
  })

  it('transitions to success status and calls onComplete', async () => {
    const onComplete = vi.fn()
    const { result } = renderHook(() => useRequestHandler(onComplete))

    const fn = vi.fn(async () => {})

    await act(() => result.current.submit(fn, 'provided'))

    expect(fn).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('provided')
    expect(result.current.error).toBeNull()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('resets to pending with error message on failure', async () => {
    const onComplete = vi.fn()
    const { result } = renderHook(() => useRequestHandler(onComplete))

    const fn = vi.fn(async () => {
      throw new Error('Network error')
    })

    await act(() => result.current.submit(fn, 'provided'))

    expect(result.current.status).toBe('pending')
    expect(result.current.error).toBe('Network error')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('uses fallback message for non-Error throws', async () => {
    const { result } = renderHook(() => useRequestHandler(vi.fn()))

    await act(() => result.current.submit(async () => {
      throw 'string error'  // eslint-disable-line no-throw-literal
    }, 'done'))

    expect(result.current.error).toBe('Request failed')
  })

  it('clears previous error on new submit', async () => {
    const onComplete = vi.fn()
    const { result } = renderHook(() => useRequestHandler(onComplete))

    // First call fails
    await act(() => result.current.submit(async () => {
      throw new Error('fail')
    }, 'done'))
    expect(result.current.error).toBe('fail')

    // Second call succeeds — error should be cleared
    await act(() => result.current.submit(async () => {}, 'done'))
    expect(result.current.error).toBeNull()
    expect(result.current.status).toBe('done')
  })

  it('supports custom success status values', async () => {
    const { result } = renderHook(() => useRequestHandler(vi.fn()))

    await act(() => result.current.submit(async () => {}, 'uploaded'))
    expect(result.current.status).toBe('uploaded')

    // Reset and try another
    await act(() => {
      result.current.setStatus('pending')
    })
    await act(() => result.current.submit(async () => {}, 'fetch-requested'))
    expect(result.current.status).toBe('fetch-requested')
  })

  it('aborts a timed-out request, resets to pending, and allows a retry', async () => {
    vi.useFakeTimers()
    try {
      const onComplete = vi.fn()
      const { result } = renderHook(() => useRequestHandler(onComplete, { timeoutMs: 100 }))
      let submittedSignal: AbortSignal | undefined

      let firstSubmit!: Promise<void>
      act(() => {
        firstSubmit = result.current.submit((signal) => {
          submittedSignal = signal
          return new Promise<void>(() => {})
        }, 'provided')
      })

      expect(result.current.status).toBe('submitting')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
        await firstSubmit
      })

      expect(submittedSignal?.aborted).toBe(true)
      expect(result.current.status).toBe('pending')
      expect(result.current.error).toBe(REQUEST_SUBMIT_TIMEOUT_MESSAGE)
      expect(onComplete).not.toHaveBeenCalled()

      await act(() => result.current.submit(async () => {}, 'provided'))
      expect(result.current.status).toBe('provided')
      expect(result.current.error).toBeNull()
      expect(onComplete).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
