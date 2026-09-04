import { describe, expect, it } from 'vitest'

import {
  defaultParseErrorResponse,
  errorPlacement,
  extractErrorMessage,
  inferErrorStatus,
  providerErrorPresentationSchema,
  resolveOrgLink,
  resolvePresentationMarkdown,
} from './error-presentation'
import { extractSubscriptionRequired, parsePlatformErrorResponse } from './platform-error-presentation'

const SPEND_CAP =
  'API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'
const STREAM_PREFIXED_SPEND_CAP =
  'Let me check what Meta is actually reporting on the ad set right now, then explain.API Error: Request rejected (429) · A spend cap for this workspace was reached. It resets within 30 days. Ask a workspace admin to raise it.'
const RATE_LIMIT = 'API Error: Request rejected (429) · Rate limit exceeded. Slow down and retry shortly.'
const BILLING_402 = 'API Error: 402 Workspace has insufficient balance. Top up to continue.'

describe('extractErrorMessage', () => {
  it('returns a plain string unchanged', () => {
    expect(extractErrorMessage('Invalid API key')).toBe('Invalid API key')
  })

  it('pulls message out of an Anthropic-shaped JSON blob', () => {
    expect(
      extractErrorMessage('prefix {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}'),
    ).toBe('prefix slow down')
  })

  it('reads error.message from a parsed body', () => {
    expect(
      extractErrorMessage({ type: 'error', error: { type: 'rate_limit_error', message: 'A spend cap for this workspace was reached.' } }),
    ).toBe('A spend cap for this workspace was reached.')
  })
})

describe('inferErrorStatus', () => {
  it('reads a parenthesized status', () => {
    expect(inferErrorStatus(SPEND_CAP)).toBe(429)
  })

  it('reads a bare 402', () => {
    expect(inferErrorStatus(BILLING_402)).toBe(402)
  })

  it('returns undefined when no status is present', () => {
    expect(inferErrorStatus('Invalid API key')).toBeUndefined()
  })
})

describe('providerErrorPresentationSchema', () => {
  const base = { severity: 'error', message: 'x', icon: 'info' }

  it('accepts the three original keys with placement and component unset', () => {
    const parsed = providerErrorPresentationSchema.parse(base)
    expect(parsed.placement).toBeUndefined()
    expect(parsed.component).toBeUndefined()
  })

  it('accepts placement and component', () => {
    expect(providerErrorPresentationSchema.parse({ ...base, placement: 'composer', component: 'paywall' })).toEqual({
      ...base,
      placement: 'composer',
      component: 'paywall',
    })
  })

  it('accepts a component key the renderer has never heard of', () => {
    expect(providerErrorPresentationSchema.safeParse({ ...base, component: 'not-registered' }).success).toBe(true)
  })

  it('rejects an unknown placement', () => {
    expect(providerErrorPresentationSchema.safeParse({ ...base, placement: 'sidebar' }).success).toBe(false)
  })
})

describe('errorPlacement', () => {
  it('defaults to inline when the presentation is missing or has no placement', () => {
    expect(errorPlacement(undefined)).toBe('inline')
    expect(errorPlacement(null)).toBe('inline')
    expect(errorPlacement({ severity: 'error', message: 'x', icon: 'info' })).toBe('inline')
  })

  it('returns the placement when set', () => {
    expect(errorPlacement({ severity: 'error', message: 'x', icon: 'info', placement: 'composer' })).toBe('composer')
  })
})

describe('defaultParseErrorResponse', () => {
  it('returns Iddo\'s three fields for a generic error', () => {
    expect(defaultParseErrorResponse(401, 'Invalid API key')).toEqual({
      severity: 'error',
      message: '**LLM Provider Error:** Invalid API key',
      icon: 'info',
    })
  })

  it('does not special-case a spend-cap 429', () => {
    const parsed = defaultParseErrorResponse(429, SPEND_CAP)
    expect(parsed.severity).toBe('error')
    expect(parsed.message).toContain('**LLM Provider Error:**')
    expect(parsed.message).not.toContain('Spend Limit Reached')
  })
})

describe('parsePlatformErrorResponse', () => {
  it('returns a warning markdown message with an admin link', () => {
    expect(parsePlatformErrorResponse(429, SPEND_CAP)).toEqual({
      severity: 'warning',
      icon: 'circle-dollar-sign',
      message:
        '**Spend Limit Reached:** A spend cap for this workspace was reached. It resets within 30 days. [Raise spend limit in the admin dashboard](/dashboard/organizations/{orgId}?tab=billing)',
    })
  })

  it('finds a spend cap after streamed assistant text', () => {
    const parsed = parsePlatformErrorResponse(undefined, STREAM_PREFIXED_SPEND_CAP)
    expect(parsed?.severity).toBe('warning')
    expect(parsed?.message).toContain('**Spend Limit Reached:**')
  })

  it('reads a spend cap from a parsed JSON body', () => {
    const parsed = parsePlatformErrorResponse(429, {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'A spend cap for this workspace was reached. It resets within 30 days.',
      },
    })
    expect(parsed?.severity).toBe('warning')
    expect(parsed?.icon).toBe('circle-dollar-sign')
  })

  it('returns null for a generic rate-limit 429 — the base provider applies the default', () => {
    expect(parsePlatformErrorResponse(429, RATE_LIMIT)).toBeNull()
  })

  it('routes a 402 to the paywall component above the composer', () => {
    expect(parsePlatformErrorResponse(402, BILLING_402)).toEqual({
      severity: 'error',
      icon: 'info',
      message: '**You need more usage credit to continue** Subscribe or top up to resume this answer.',
      component: 'paywall',
      placement: 'composer',
    })
  })

  it('tailors the 402 copy to the subscription_required flag when the body kept it', () => {
    const needsPlan = parsePlatformErrorResponse(402, '{"error":"insufficient_balance","subscription_required":true}')
    expect(needsPlan?.message).toContain('Subscribe')
    expect(needsPlan?.message).not.toContain('top up')
    const needsCredit = parsePlatformErrorResponse(402, '{"error":"insufficient_balance","subscription_required":false}')
    expect(needsCredit?.message).toContain('Add usage credit')
  })

  it('recognizes a 402 the CLI flattened into an "API Error: 402" string', () => {
    const parsed = parsePlatformErrorResponse(undefined, 'API Error: 402 {"error":"insufficient_balance"}')
    expect(parsed?.component).toBe('paywall')
  })

  it('does not route a non-402 status to the paywall because "402" appears elsewhere in the text', () => {
    expect(parsePlatformErrorResponse(undefined, 'Request rejected (500) · upstream id 402-abc')).toBeNull()
    expect(parsePlatformErrorResponse(500, 'upstream id 402')).toBeNull()
  })
})

describe('extractSubscriptionRequired', () => {
  it('reads the flag from a JSON body or an embedded JSON object', () => {
    expect(extractSubscriptionRequired({ error: 'x', subscription_required: true })).toBe(true)
    expect(extractSubscriptionRequired('API Error: 402 {"subscription_required":false}')).toBe(false)
  })

  it('is undefined when the body dropped the flag', () => {
    expect(extractSubscriptionRequired('API Error: 402 {"error":"insufficient_balance"}')).toBeUndefined()
    expect(extractSubscriptionRequired('Payment required')).toBeUndefined()
  })
})

describe('resolveOrgLink', () => {
  const org = { connected: true, platformBaseUrl: 'https://platform.example.com/', orgId: 'org_123' }

  it('fills orgId and prefixes the origin without a double slash', () => {
    expect(resolveOrgLink('/dashboard/organizations/{orgId}?tab=billing', org)).toBe(
      'https://platform.example.com/dashboard/organizations/org_123?tab=billing',
    )
  })

  it('leaves an absolute URL on its own host', () => {
    expect(resolveOrgLink('https://docs.example.com/{orgId}', org)).toBe('https://docs.example.com/org_123')
  })

  it('is null without a connected org', () => {
    expect(resolveOrgLink('/x/{orgId}', null)).toBeNull()
    expect(resolveOrgLink('/x/{orgId}', { ...org, connected: false })).toBeNull()
    expect(resolveOrgLink('/x/{orgId}', { ...org, orgId: null })).toBeNull()
    expect(resolveOrgLink('/x/{orgId}', { ...org, platformBaseUrl: null })).toBeNull()
  })
})

describe('resolvePresentationMarkdown', () => {
  const org = {
    connected: true,
    platformBaseUrl: 'https://platform.example.com',
    orgId: 'org_123',
  }
  const markdown =
    '**Spend Limit Reached:** A spend cap. [Raise spend limit](/dashboard/organizations/{orgId}?tab=billing)'

  it('fills orgId and prefixes the platform origin', () => {
    expect(resolvePresentationMarkdown(markdown, org)).toBe(
      '**Spend Limit Reached:** A spend cap. [Raise spend limit](https://platform.example.com/dashboard/organizations/org_123?tab=billing)',
    )
  })

  it('strips the link when org context is missing', () => {
    expect(
      resolvePresentationMarkdown(markdown, { connected: false, platformBaseUrl: org.platformBaseUrl, orgId: org.orgId }),
    ).toBe('**Spend Limit Reached:** A spend cap. Raise spend limit')
    expect(
      resolvePresentationMarkdown(markdown, { connected: true, platformBaseUrl: org.platformBaseUrl, orgId: null }),
    ).toBe('**Spend Limit Reached:** A spend cap. Raise spend limit')
  })
})
