/**
 * Slack error classification for the connector's reconnect loop.
 *
 * The five codes below are what @slack/socket-mode calls
 * UnrecoverableSocketModeStartError: a workspace/app in this state will never
 * come back no matter how often we retry (revoked token, deactivated account,
 * disabled workspace). The connector must stop its reconnect loop and surface
 * the failure instead of hammering Slack forever.
 *
 * Everything else — network-level request errors, HTTP errors, other platform
 * errors — is treated as transient and retried with backoff.
 */

const UNRECOVERABLE_SLACK_ERROR_CODES = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'user_removed_from_team',
  'team_disabled',
])

/** @slack/web-api ErrorCode.PlatformError — an ok:false API response. */
const SLACK_PLATFORM_ERROR_CODE = 'slack_webapi_platform_error'

export function isUnrecoverableSlackError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; data?: { error?: unknown } }
  return (
    e.code === SLACK_PLATFORM_ERROR_CODE &&
    typeof e.data?.error === 'string' &&
    UNRECOVERABLE_SLACK_ERROR_CODES.has(e.data.error)
  )
}
