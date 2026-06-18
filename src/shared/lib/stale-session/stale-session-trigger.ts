import { STALE_TIME_GAP_MS, STALE_CONTEXT_TOKENS } from './stale-session-config'

export interface StaleInput {
  idleMs: number          // now - lastActivityAt
  contextTokens: number   // currentContextTokens(lastUsage)
  isAwaitingInput: boolean
  isRunning: boolean
}

export interface StaleDecision {
  shouldPrompt: boolean
}

// Pure staleness predicate: "is this conversation stale right now". Dismissal is
// no longer an input here — it is a UI suppression (local Ignore in the chat
// column), not a persisted property of staleness.
export function evaluateStalePrompt(i: StaleInput): StaleDecision {
  if (i.isAwaitingInput || i.isRunning) return { shouldPrompt: false }
  // Both must hold (AND): idle long enough that the prompt isn't mid-flow,
  // AND large enough that continuing is genuinely costly. A small session is
  // cheap to continue; a large-but-active one is bounded by auto-compact.
  const shouldPrompt = i.idleMs > STALE_TIME_GAP_MS && i.contextTokens > STALE_CONTEXT_TOKENS
  return { shouldPrompt }
}
