import type { SessionActivity } from '@shared/lib/types/agent'

export interface ActivityState {
  isActive: boolean
  isAwaitingInput: boolean
  isCompacting: boolean
  isRetrying: boolean
  isThinking: boolean
  isStreaming: boolean
  hasToolUse: boolean
}

/**
 * A session's state as one activity label, with the app's indicator
 * precedence: compacting > retrying > thinking > working. Streamed reply TEXT
 * owns the reply surface ('streaming', where chat yields its placeholder); a
 * thinking or tool block does not. Checked after the busier states, so a
 * stale streaming flag (an api_retry mid-stream) never shows 'streaming'
 * while the app honestly says "Retrying…" for the same state.
 */
export function computeActivity(state: ActivityState): SessionActivity {
  if (!state.isActive) return 'idle'
  if (state.isAwaitingInput) return 'awaiting'
  if (state.isCompacting) return 'compacting'
  if (state.isRetrying) return 'retrying'
  if (state.isThinking) return 'thinking'
  if (state.isStreaming && !state.hasToolUse) return 'streaming'
  return 'working'
}
