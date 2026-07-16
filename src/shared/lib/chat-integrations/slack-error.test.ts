import { describe, it, expect } from 'vitest'
import { isUnrecoverableSlackError } from './slack-error'

// The five codes @slack/socket-mode classifies as UnrecoverableSocketModeStartError:
// a workspace/app in this state will never reconnect no matter how often we retry,
// so the connector must stop its loop and surface the error instead.
const UNRECOVERABLE_CODES = [
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'user_removed_from_team',
  'team_disabled',
]

function platformError(code: string): Error {
  const err = new Error(`An API error occurred: ${code}`) as Error & {
    code: string
    data: { ok: false; error: string }
  }
  err.code = 'slack_webapi_platform_error'
  err.data = { ok: false, error: code }
  return err
}

describe('isUnrecoverableSlackError', () => {
  it.each(UNRECOVERABLE_CODES)('flags platform error %s as unrecoverable', (code) => {
    expect(isUnrecoverableSlackError(platformError(code))).toBe(true)
  })

  it('does not flag other platform errors (transient / recoverable)', () => {
    expect(isUnrecoverableSlackError(platformError('ratelimited'))).toBe(false)
    expect(isUnrecoverableSlackError(platformError('internal_error'))).toBe(false)
  })

  it('does not flag network-level request errors — those are retryable', () => {
    const err = new Error('A request error occurred: getaddrinfo ENOTFOUND slack.com') as Error & { code: string }
    err.code = 'slack_webapi_request_error'
    expect(isUnrecoverableSlackError(err)).toBe(false)
  })

  it('does not flag HTTP errors — Slack outages and proxies recover', () => {
    const err = new Error('An HTTP protocol error occurred: statusCode = 503') as Error & { code: string }
    err.code = 'slack_webapi_http_error'
    expect(isUnrecoverableSlackError(err)).toBe(false)
  })

  it('handles plain errors, null, and malformed shapes', () => {
    expect(isUnrecoverableSlackError(new Error('boom'))).toBe(false)
    expect(isUnrecoverableSlackError(null)).toBe(false)
    expect(isUnrecoverableSlackError(undefined)).toBe(false)
    expect(isUnrecoverableSlackError('invalid_auth')).toBe(false)
    expect(isUnrecoverableSlackError({ code: 'slack_webapi_platform_error' })).toBe(false)
    expect(isUnrecoverableSlackError({ code: 'slack_webapi_platform_error', data: { error: 42 } })).toBe(false)
  })
})
