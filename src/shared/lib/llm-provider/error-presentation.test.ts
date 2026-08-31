import { describe, expect, it } from 'vitest'

import {
  defaultParseErrorResponse,
  extractErrorMessage,
  inferErrorStatus,
  resolvePresentationMarkdown,
} from './error-presentation'
import { parsePlatformErrorResponse } from './platform-error-presentation'

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

  it('returns markdown with a billing link for a 402', () => {
    expect(parsePlatformErrorResponse(402, BILLING_402)).toEqual({
      severity: 'error',
      icon: 'info',
      message:
        '**Insufficient Balance:** Subscribe or top up to continue running agents. [Go to billing](/dashboard/organizations/{orgId}?tab=billing)',
    })
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
