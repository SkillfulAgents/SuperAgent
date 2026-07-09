import { describe, it, expect } from 'vitest'
import { NonRetryableError } from '../utils/retry'
import { mapPlatformWebError } from './platform-web-error'

describe('mapPlatformWebError', () => {
  it.each([401, 403])('maps %i to a sign-in-again message naming the surface', (status) => {
    const out = mapPlatformWebError(new NonRetryableError('x', status), 'search')
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toMatch(/web search is unavailable.*session has expired or is invalid.*Sign in again/i)
  })

  it('maps 402 to a billing message naming the surface', () => {
    const out = mapPlatformWebError(new NonRetryableError('x', 402), 'fetch')
    expect((out as Error).message).toMatch(/web fetch is unavailable.*billing issue/i)
  })

  it('passes a non-mapped NonRetryableError through unchanged', () => {
    const err = new NonRetryableError('Platform request failed: 404', 404)
    expect(mapPlatformWebError(err, 'search')).toBe(err)
  })

  it('passes a non-NonRetryableError (e.g. a network Error) through unchanged', () => {
    const err = new Error('network down')
    expect(mapPlatformWebError(err, 'fetch')).toBe(err)
  })
})
