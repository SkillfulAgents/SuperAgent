import { describe, expect, it } from 'vitest'

import { isProviderFacingError, isUpstreamApiErrorCode, NON_UPSTREAM_ERROR_CODES, PROVIDER_ERROR_CODES } from './api'

const presentation = { severity: 'error' as const, message: 'x', icon: 'info' }

// `SDKAssistantMessageError` from @anthropic-ai/claude-agent-sdk (agent-container pin). The host
// cannot import the SDK types, so the enum is pinned here; update on an SDK bump.
const SDK_ASSISTANT_ERROR_CODES = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'model_not_found',
  'server_error',
  'unknown',
  'max_output_tokens',
] as const

// Upstream codes with no generic banner; provider-facing only when a presentation is attached.
const UPSTREAM_WITHOUT_BANNER = ['oauth_org_not_allowed', 'account_on_hold', 'overloaded', 'model_not_found', 'unknown']

describe('SDK error code classification', () => {
  it('keeps NON_UPSTREAM_ERROR_CODES and PROVIDER_ERROR_CODES disjoint', () => {
    for (const code of NON_UPSTREAM_ERROR_CODES) expect(PROVIDER_ERROR_CODES.has(code)).toBe(false)
  })

  it('classifies every SDK code exactly once (drift here must be a deliberate choice)', () => {
    const classified = [...NON_UPSTREAM_ERROR_CODES, ...PROVIDER_ERROR_CODES, ...UPSTREAM_WITHOUT_BANNER].sort()
    expect(classified).toEqual([...SDK_ASSISTANT_ERROR_CODES].sort())
  })

  it('treats every code outside NON_UPSTREAM_ERROR_CODES as upstream', () => {
    for (const code of SDK_ASSISTANT_ERROR_CODES) {
      expect(isUpstreamApiErrorCode(code)).toBe(!NON_UPSTREAM_ERROR_CODES.has(code))
    }
  })
})

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
