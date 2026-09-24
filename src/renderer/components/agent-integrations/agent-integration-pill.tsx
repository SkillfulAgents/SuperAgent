import { Pause } from 'lucide-react'
import {
  type AgentIntegrationState,
  AGENT_INTEGRATION_STATE_LABEL,
  AGENT_INTEGRATION_STATE_PILL,
} from '@shared/lib/agent-integrations/presentation'

// Dot/icon treatment per state. Pulse marks the in-progress state (Connecting);
// the settled live state (Listening) shows a steady dot - pulse = transitioning,
// steady = up. Paused shows a pause glyph instead of a dot.
const STATE_DOT: Record<AgentIntegrationState, { dot?: string; pulse?: boolean; pauseIcon?: boolean }> = {
  reconnect_needed: { dot: 'bg-amber-500' },
  disconnected: { dot: 'bg-muted-foreground' },
  paused: { pauseIcon: true },
  connecting: { dot: 'bg-green-500', pulse: true },
  working: { dot: 'bg-green-500' },
  degraded: { dot: 'bg-amber-500' },
  error: { dot: 'bg-red-500' },
}

/**
 * The one status pill for a chat integration: label + color from the shared state
 * vocabulary, so every surface (the connector Status card, the agent-home tag)
 * renders the same thing from a derived `AgentIntegrationState` instead of
 * re-implementing it. `size="sm"` is the card pill; `size="xs"` the compact home
 * tag. `showDot` adds the state dot / pause glyph (defaults on for `sm`, off for
 * `xs`, matching each surface's existing treatment).
 */
export function AgentIntegrationPill({ state, size = 'sm', showDot = size === 'sm' }: {
  state: AgentIntegrationState
  size?: 'sm' | 'xs'
  showDot?: boolean
}) {
  const display = STATE_DOT[state]
  const sizing = size === 'sm' ? 'px-1.5 py-0.5 text-xs font-medium' : 'px-1.5 py-0 text-2xs'
  const dot = showDot
    ? display.pauseIcon
      ? <Pause className="h-2.5 w-2.5 fill-current" />
      : <span className={`h-1.5 w-1.5 rounded-full ${display.dot} ${display.pulse ? 'animate-pulse' : ''}`} />
    : null
  return (
    <span className={`${dot ? 'inline-flex items-center gap-1 ' : ''}rounded-full ${sizing} ${AGENT_INTEGRATION_STATE_PILL[state]}`}>
      {dot}
      {AGENT_INTEGRATION_STATE_LABEL[state]}
    </span>
  )
}
