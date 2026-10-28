import { STALE_CONTEXT_TOKENS, STALE_TIME_GAP_MS } from './stale-session-config'

export interface StaleInput {
  idleMs: number
  contextTokens: number
  isAwaitingInput: boolean
  isRunning: boolean
}

/** Pure predicate for deciding whether a stale-session prompt is appropriate. */
export function shouldPromptForNewSession(input: StaleInput): boolean {
  if (input.isAwaitingInput || input.isRunning) return false

  return input.idleMs > STALE_TIME_GAP_MS && input.contextTokens > STALE_CONTEXT_TOKENS
}
