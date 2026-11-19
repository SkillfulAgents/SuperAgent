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

export function isUnrecoverableSlackError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; data?: { error?: unknown } }
  return (
    e.code === SLACK_PLATFORM_ERROR_CODE &&
    typeof e.data?.error === 'string' &&
    UNRECOVERABLE_SLACK_ERROR_CODES.has(e.data.error)
  )
}

// Slack refusing a message's blocks, e.g. markdown_text that converts to more than 50 blocks.
const BLOCKS_REJECTION_CODES = new Set(['invalid_blocks', 'msg_blocks_too_long'])

export function isSlackBlocksRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; data?: { error?: unknown } }
  return e.code === SLACK_PLATFORM_ERROR_CODE && typeof e.data?.error === 'string' && BLOCKS_REJECTION_CODES.has(e.data.error)
}

/** Slack refusing an image block whose uploaded file it is still processing: `invalid_blocks` naming the file. */
export function isSlackFileNotReady(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; data?: { error?: unknown; response_metadata?: { messages?: unknown } } }
  const messages = e.data?.response_metadata?.messages
  return e.code === SLACK_PLATFORM_ERROR_CODE && e.data?.error === 'invalid_blocks' &&
    Array.isArray(messages) && messages.some((message) => typeof message === 'string' && message.includes('invalid slack file'))
}
