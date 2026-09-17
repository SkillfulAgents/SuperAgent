import type { IntegrationStatus } from './types'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  imessage: 'iMessage',
}

/**
 * The single status the user sees for an integration, derived from the
 * persisted lifecycle (`status`) plus the live transport (`connected`):
 *
 *   Paused      — toggled off; won't connect.
 *   Connecting  — toggled on, wire not up yet.
 *   Listening   — toggled on and the wire is up.
 *   Error       — toggled on but a connect attempt failed; retrying.
 */
export type AgentIntegrationState = 'disconnected' | 'reconnect_needed' | 'paused' | 'connecting' | 'working' | 'error'

export function deriveAgentIntegrationState(
  status: IntegrationStatus,
  connected?: boolean,
  reconnectRequired = false,
): AgentIntegrationState {
  if (reconnectRequired) return 'reconnect_needed'
  if (status === 'disconnected') return 'disconnected'
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
export const AGENT_INTEGRATION_STATE_LABEL: Record<AgentIntegrationState, string> = {
  disconnected: 'Setup required',
  reconnect_needed: 'Reconnect needed',
  paused: 'Paused',
  connecting: 'Connecting…',
  working: 'Listening',
  error: 'Error',
}

/** Pill colors per state, shared by the Status card tag and the agent-home tag
 *  so the two surfaces stay visually in sync. */
export const AGENT_INTEGRATION_STATE_PILL: Record<AgentIntegrationState, string> = {
  disconnected: 'bg-muted text-muted-foreground',
  reconnect_needed: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
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
