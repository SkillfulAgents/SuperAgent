/**
 * Slack error classification: when the reconnect loop must stop, and when Slack refused a message's blocks.
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

/** The code of an ok:false Slack API response (e.g. not_in_channel), or undefined for any other error. */
function slackPlatformErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err) || err.code !== SLACK_PLATFORM_ERROR_CODE || !('data' in err)) return undefined
  const { data } = err
  return data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : undefined
}

export function isUnrecoverableSlackError(err: unknown): boolean {
  const code = slackPlatformErrorCode(err)
  return code !== undefined && UNRECOVERABLE_SLACK_ERROR_CODES.has(code)
}

// Slack refusing a message's blocks, e.g. markdown_text that converts to more than 50 blocks.
const BLOCKS_REJECTION_CODES = new Set(['invalid_blocks', 'msg_blocks_too_long'])

export function isSlackBlocksRejection(err: unknown): boolean {
  const code = slackPlatformErrorCode(err)
  return code !== undefined && BLOCKS_REJECTION_CODES.has(code)
}

// Slack declining a history read for a reason the agent or the person it answers can act on
// (missing_scope: the Slack app predates the history scopes). Other codes are faults.
const HISTORY_REFUSAL_CODES = new Set(['not_in_channel', 'channel_not_found', 'thread_not_found', 'invalid_arguments', 'invalid_cursor', 'missing_scope'])

export function slackHistoryRefusal(err: unknown): string | undefined {
  const code = slackPlatformErrorCode(err)
  if (code !== undefined) return HISTORY_REFUSAL_CODES.has(code) ? code : undefined
  // The client waits out each 429 and retries; once its retries run out, @slack/web-api
  // rethrows an uncoded Error whose message is the only marker of a rate limit.
  return err instanceof Error && err.message.startsWith('A rate limit was exceeded') ? 'ratelimited' : undefined
}
