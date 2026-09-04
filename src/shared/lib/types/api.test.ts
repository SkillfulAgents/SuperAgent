import { describe, expect, it } from 'vitest'

import { isProviderFacingError } from './api'

const presentation = { severity: 'error' as const, message: 'x', icon: 'info' }

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
