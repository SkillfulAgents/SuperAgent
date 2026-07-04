import { Pause } from 'lucide-react'
import {
  type ChatIntegrationState,
  CHAT_INTEGRATION_STATE_LABEL,
  CHAT_INTEGRATION_STATE_PILL,
} from '@shared/lib/chat-integrations/utils'

// Dot/icon treatment per state. Pulse marks the in-progress state (Connecting);
// the settled live state (Listening) shows a steady dot - pulse = transitioning,
// steady = up. Paused shows a pause glyph instead of a dot.
const STATE_DOT: Record<ChatIntegrationState, { dot?: string; pulse?: boolean; pauseIcon?: boolean }> = {
  paused: { pauseIcon: true },
  connecting: { dot: 'bg-green-500', pulse: true },
  working: { dot: 'bg-green-500' },
  error: { dot: 'bg-red-500' },
}

/**
 * The one status pill for a chat integration: label + color from the shared state
 * vocabulary, so every surface (the connector Status card, the agent-home tag)
 * renders the same thing from a derived `ChatIntegrationState` instead of
 * re-implementing it. `size="sm"` is the card pill; `size="xs"` the compact home
 * tag. `showDot` adds the state dot / pause glyph (defaults on for `sm`, off for
 * `xs`, matching each surface's existing treatment).
 */
export function ChatIntegrationPill({ state, size = 'sm', showDot = size === 'sm' }: {
  state: ChatIntegrationState
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
    <span className={`${dot ? 'inline-flex items-center gap-1 ' : ''}rounded-full ${sizing} ${CHAT_INTEGRATION_STATE_PILL[state]}`}>
      {dot}
      {CHAT_INTEGRATION_STATE_LABEL[state]}
    </span>
  )
}
