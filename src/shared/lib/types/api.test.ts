import { describe, expect, it } from 'vitest'

import { isProviderFacingError, isUpstreamApiErrorCode } from './api'

const presentation = { severity: 'error' as const, message: 'x', icon: 'info' }

describe('isUpstreamApiErrorCode', () => {
  it('is true for any SDK code that marks an upstream API failure, including unknown', () => {
    expect(isUpstreamApiErrorCode('rate_limit')).toBe(true)
    expect(isUpstreamApiErrorCode('unknown')).toBe(true)
    expect(isUpstreamApiErrorCode('overloaded')).toBe(true)
  })

  it('is false for max_output_tokens and for no code at all', () => {
    expect(isUpstreamApiErrorCode('max_output_tokens')).toBe(false)
    expect(isUpstreamApiErrorCode(null)).toBe(false)
    expect(isUpstreamApiErrorCode(undefined)).toBe(false)
  })
})

describe('isProviderFacingError', () => {
  it('is true for a provider SDK code without a presentation', () => {
    expect(isProviderFacingError('rate_limit')).toBe(true)
    expect(isProviderFacingError('billing_error', null)).toBe(true)
  })

  it('is true whenever a presentation is attached, regardless of the SDK code', () => {
    expect(isProviderFacingError('unknown', presentation)).toBe(true)
    expect(isProviderFacingError(null, presentation)).toBe(true)
  })

  it('is false for a non-provider SDK code with no presentation', () => {
    expect(isProviderFacingError('max_output_tokens')).toBe(false)
    expect(isProviderFacingError(null)).toBe(false)
    expect(isProviderFacingError(undefined, null)).toBe(false)
  })
})
