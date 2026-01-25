import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './retry'

describe('withRetry', () => {
  it('returns result on first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success')

    const result = await withRetry(fn)

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on failure and succeeds on second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValue('success')

    const result = await withRetry(fn, 3, 10) // Use short delay for fast tests

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on failure and succeeds on third attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue('success')

    const result = await withRetry(fn, 3, 10)

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws last error after all retries exhausted', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))

    await expect(withRetry(fn, 3, 10)).rejects.toThrow('third')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('uses exponential backoff for delays', async () => {
    const callTimes: number[] = []

    const fn = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now())
      if (fn.mock.calls.length < 4) {
        throw new Error(`attempt ${fn.mock.calls.length}`)
      }
      return 'success'
    })

    const result = await withRetry(fn, 4, 20)
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(4)

    // Verify delays are roughly exponential: 20ms, 40ms, 80ms
    // Allow some tolerance for timing variations
    const delays = callTimes.slice(1).map((t, i) => t - callTimes[i])
    expect(delays[0]).toBeGreaterThanOrEqual(15) // ~20ms
    expect(delays[0]).toBeLessThan(40)
    expect(delays[1]).toBeGreaterThanOrEqual(35) // ~40ms
    expect(delays[1]).toBeLessThan(80)
    expect(delays[2]).toBeGreaterThanOrEqual(70) // ~80ms
    expect(delays[2]).toBeLessThan(160)
  })

  it('respects custom maxRetries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'))

    await expect(withRetry(fn, 5, 5)).rejects.toThrow('always fails')
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('respects custom baseDelayMs', async () => {
    const callTimes: number[] = []

    const fn = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now())
      if (fn.mock.calls.length === 1) {
        throw new Error('fail')
      }
      return 'success'
    })

    const result = await withRetry(fn, 2, 50)
    expect(result).toBe('success')

    const delay = callTimes[1] - callTimes[0]
    expect(delay).toBeGreaterThanOrEqual(45) // ~50ms with some tolerance
    expect(delay).toBeLessThan(100)
  })

  it('uses default values when not specified', async () => {
    const fn = vi.fn().mockResolvedValue('success')

    const result = await withRetry(fn)

    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('handles non-Error throws', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce('string error')
      .mockRejectedValueOnce({ code: 'CUSTOM' })
      .mockRejectedValueOnce(42)

    await expect(withRetry(fn, 3, 5)).rejects.toBe(42)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('preserves return type', async () => {
    interface User {
      id: number
      name: string
    }

    const fn = vi.fn().mockResolvedValue({ id: 1, name: 'Test' })

    const result: User = await withRetry(fn)

    expect(result.id).toBe(1)
    expect(result.name).toBe('Test')
  })

  it('works with async functions that have side effects', async () => {
    let counter = 0
    const fn = vi.fn().mockImplementation(async () => {
      counter++
      if (counter < 3) {
        throw new Error(`attempt ${counter}`)
      }
      return counter
    })

    const result = await withRetry(fn, 3, 5)

    expect(result).toBe(3)
    expect(counter).toBe(3)
  })

  it('does not retry when maxRetries is 1', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))

    await expect(withRetry(fn, 1, 5)).rejects.toThrow('fail')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
