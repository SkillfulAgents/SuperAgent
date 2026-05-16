/**
 * Chat integration utility functions.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  imessage: 'iMessage',
}

/** Format a provider slug for display (e.g. "telegram" → "Telegram", "imessage" → "iMessage"). */
export function formatProviderName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

// Event types that need the desktop app (OAuth callbacks, browser input, script approval, etc.).
const UNSUPPORTED_IN_CHAT: ReadonlySet<UserRequestEvent['type']> = new Set([
  'connected_account_request',
  'remote_mcp_request',
  'browser_input_request',
  'script_run_request',
  'computer_use_request',
])

export function isUnsupportedInChat(event: UserRequestEvent): boolean {
  return UNSUPPORTED_IN_CHAT.has(event.type)
}

/**
 * Plain-text user-facing message for an event the chat integration can't fulfill.
 * Connectors wrap this in their own formatting (Telegram HTML, Slack mrkdwn).
 */
export function describeUnsupportedRequest(event: UserRequestEvent): string {
  const tail = ' Open Superagent on your desktop to continue.'
  switch (event.type) {
    case 'connected_account_request':
      return `The agent wants to connect your ${event.toolkit} account, which isn't supported in chat.${tail}`
    case 'remote_mcp_request':
      return `The agent wants to connect to a remote MCP server${event.name ? ` (${event.name})` : ''}, which isn't supported in chat.${tail}`
    case 'browser_input_request':
      return `The agent needs input in a browser session, which isn't supported in chat.${tail}`
    case 'script_run_request':
      return `The agent wants to run a script, which needs your approval.${tail}`
    case 'computer_use_request':
      return `The agent wants to use your computer, which isn't supported in chat.${tail}`
    default:
      return `The agent sent a "${event.type}" request that isn't supported in chat.${tail}`
  }
}
