/**
 * Chat integration utility functions.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  imessage: 'iMessage',
}

/** Format a Date as a human-readable timestamp for session names (e.g. "May 20, 2:30 PM"). */
export function formatSessionTimestamp(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** Format a provider slug for display (e.g. "telegram" → "Telegram", "imessage" → "iMessage"). */
export function formatProviderName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

// Event types that need the desktop app (OAuth callbacks, browser input, script approval, etc.).
// secret_request / file_request are here too: neither is wired to complete in chat, and a secret
// typed into a chat thread leaks into the provider's cloud and the transcript - the vault path is
// the desktop app's job.
const UNSUPPORTED_IN_CHAT: ReadonlySet<UserRequestEvent['type']> = new Set([
  'connected_account_request',
  'remote_mcp_request',
  'browser_input_request',
  'script_run_request',
  'computer_use_request',
  'secret_request',
  'file_request',
])

export function isUnsupportedInChat(event: UserRequestEvent): boolean {
  return UNSUPPORTED_IN_CHAT.has(event.type)
}

/**
 * Split a message into chunks that fit within a provider's max message length.
 * Prefers splitting at paragraph boundaries (\n\n), then line boundaries (\n),
 * falling back to a hard split at maxLength.
 */
export function splitChatMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n\n', maxLength)
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf('\n', maxLength)
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength
    }
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

/**
 * Plain-text user-facing message for an event the chat integration can't fulfill.
 * Connectors wrap this in their own formatting (Telegram HTML, Slack mrkdwn).
 */
export function describeUnsupportedRequest(event: UserRequestEvent): string {
  const tail = ' Open Gamut on your desktop to continue.'
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
    case 'secret_request':
      return `The agent needs the secret ${event.secretName}, which isn't safe to provide in chat.${tail}`
    case 'file_request':
      return `The agent wants you to upload a file${event.description ? ` (${event.description})` : ''}, which isn't supported in chat.${tail}`
    default:
      return `The agent sent a "${event.type}" request that isn't supported in chat.${tail}`
  }
}
