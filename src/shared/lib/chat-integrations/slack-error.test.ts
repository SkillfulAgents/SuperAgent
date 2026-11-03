import { describe, it, expect } from 'vitest'
import { isSlackBlocksRejection, isUnrecoverableSlackError, slackHistoryRefusal } from './slack-error'

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

describe('isSlackBlocksRejection', () => {
  it('flags both block refusals and nothing else', () => {
    expect(isSlackBlocksRejection(platformError('invalid_blocks'))).toBe(true)
    expect(isSlackBlocksRejection(platformError('msg_blocks_too_long'))).toBe(true)
    expect(isSlackBlocksRejection(platformError('msg_too_long'))).toBe(false)
    expect(isSlackBlocksRejection(new Error('invalid_blocks'))).toBe(false)
  })
})

describe('slackHistoryRefusal', () => {
  const platform = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), { code: 'slack_webapi_platform_error', data: { ok: false, error } })

  it('names the codes the agent or its user can act on', () => {
    for (const code of ['not_in_channel', 'channel_not_found', 'thread_not_found', 'invalid_arguments', 'invalid_cursor', 'missing_scope']) {
      expect(slackHistoryRefusal(platform(code))).toBe(code)
    }
  })

  it('names a rate limit the client gave up retrying', () => {
    expect(slackHistoryRefusal(new Error('A rate limit was exceeded (url: conversations.history, retry-after: 30)'))).toBe('ratelimited')
  })

  it('leaves Slack faults and non-platform errors to be reported', () => {
    expect(slackHistoryRefusal(platform('internal_error'))).toBeUndefined()
    expect(slackHistoryRefusal(platform('invalid_auth'))).toBeUndefined()
    expect(slackHistoryRefusal(new Error('socket hang up'))).toBeUndefined()
  })
})
