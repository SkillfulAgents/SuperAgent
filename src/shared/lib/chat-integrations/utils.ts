/**
 * Chat integration utility functions.
 */

import type { UserRequestEvent } from '@shared/lib/tool-definitions/types'
import type { ChatIntegration } from '@shared/lib/db/schema'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  imessage: 'iMessage',
}

/**
 * The single status the user sees for a chat integration, derived from the
 * persisted lifecycle (`status`) plus the live transport (`connected`):
 *
 *   Paused      — toggled off; won't connect.
 *   Connecting  — toggled on, wire not up yet.
 *   Listening   — toggled on and the wire is up.
 *   Error       — toggled on but a connect attempt failed; retrying.
 */
export type ChatIntegrationState = 'paused' | 'connecting' | 'working' | 'error'

export function deriveChatIntegrationState(
  status: ChatIntegration['status'],
  connected?: boolean,
): ChatIntegrationState {
  if (status === 'paused') return 'paused'
  if (status === 'error') return 'error'
  return connected ? 'working' : 'connecting'
}

/**
 * Whether an integration is mid-connect: toggled on but the transport isn't up yet
 * (the transient "Connecting…" state). The status card and the agent-home tag both
 * fast-poll while this holds so they converge to "Listening" promptly instead of
 * waiting a full idle interval - one predicate so the two surfaces can't drift.
 * A failed connect settles to `status: 'error'`, so this can't stay true forever.
 */
export function isSettling(status: string, connected?: boolean): boolean {
  return status === 'active' && !connected
}

/** User-facing label per state. The one place these words live, so the Status
 *  card and the agent-home status tag can't drift apart. */
export const CHAT_INTEGRATION_STATE_LABEL: Record<ChatIntegrationState, string> = {
  paused: 'Paused',
  connecting: 'Connecting…',
  working: 'Listening',
  error: 'Error',
}

/** Pill colors per state, shared by the Status card tag and the agent-home tag
 *  so the two surfaces stay visually in sync. */
export const CHAT_INTEGRATION_STATE_PILL: Record<ChatIntegrationState, string> = {
  paused: 'bg-muted text-muted-foreground',
  connecting: 'bg-green-500/10 text-green-700 dark:text-green-400',
  working: 'bg-green-500/10 text-green-700 dark:text-green-400',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400',
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

/** Where to send the user when chat can't fulfill a request. */
export interface AppLinkContext {
  isDesktop: boolean
  url: string | null
}

/**
 * Resolve the app surface + optional deep/web link for an agent.
 * Env reads stay inside this function (SUPERAGENT_PROTOCOL is assigned after
 * this module is imported in Electron main).
 */
export function resolveAppLinkContext(agentSlug: string): AppLinkContext {
  if (process.type === 'browser') {
    const scheme = process.env.SUPERAGENT_PROTOCOL ?? 'superagent'
    return { isDesktop: true, url: `${scheme}://agent/${encodeURIComponent(agentSlug)}` }
  }
  const base = process.env.HOST_PUBLIC_URL?.trim().replace(/\/+$/, '')
  return { isDesktop: false, url: base ? `${base}/agents/${encodeURIComponent(agentSlug)}` : null }
}

/**
 * Plain-text user-facing message for an event the chat integration can't fulfill.
 * Connectors wrap this in their own formatting (Telegram HTML, Slack mrkdwn).
 */
export function describeUnsupportedRequest(event: UserRequestEvent, appLink?: AppLinkContext): string {
  const isDesktop = appLink?.isDesktop ?? true // no-context fallback = current behavior
  const url = appLink?.url ?? null
  const tail = ` Open Gamut${isDesktop ? ' on your desktop' : ''} to continue${url ? `: ${url}` : '.'}`
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
