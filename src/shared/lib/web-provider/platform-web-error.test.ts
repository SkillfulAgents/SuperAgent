import { describe, it, expect } from 'vitest'
import { NonRetryableError } from '../utils/retry'
import { mapPlatformWebError } from './platform-web-error'

describe('mapPlatformWebError', () => {
  it('maps 401 (expired/revoked token) to a sign-in-again message naming the surface', () => {
    const out = mapPlatformWebError(new NonRetryableError('x', 401), 'search')
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toMatch(/web search is unavailable.*session has expired or is invalid.*Sign in again/i)
  })

  // The proxy returns 403 for trial-ended / inactive-member / wrong-org, none of which signing in
  // again resolves. Telling the user to sign in there is worse than saying nothing.
  it('maps 403 (no account access) to account copy, NOT sign-in-again', () => {
    const out = mapPlatformWebError(new NonRetryableError('x', 403), 'search')
    const message = (out as Error).message
    expect(message).toMatch(/does not have access.*trial may have ended.*membership is inactive/i)
    expect(message).toMatch(/Check your account/i)
    expect(message).not.toMatch(/sign in again/i)
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
