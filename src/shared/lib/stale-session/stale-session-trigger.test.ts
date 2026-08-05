import { describe, expect, it } from 'vitest'
import { STALE_CONTEXT_TOKENS, STALE_TIME_GAP_MS } from './stale-session-config'
import { shouldPromptForNewSession } from './stale-session-trigger'

const base = {
  idleMs: 0,
  contextTokens: 0,
  isAwaitingInput: false,
  isRunning: false,
}

describe('shouldPromptForNewSession', () => {
  it('requires both an old session and a large context', () => {
    expect(shouldPromptForNewSession({ ...base, idleMs: STALE_TIME_GAP_MS + 1 })).toBe(false)
    expect(shouldPromptForNewSession({ ...base, contextTokens: STALE_CONTEXT_TOKENS + 1 })).toBe(false)
    expect(shouldPromptForNewSession({
      ...base,
      idleMs: STALE_TIME_GAP_MS + 1,
      contextTokens: STALE_CONTEXT_TOKENS + 1,
    })).toBe(true)
  })

  it('does not prompt while the session is running or awaiting input', () => {
    const stale = {
      ...base,
      idleMs: STALE_TIME_GAP_MS + 1,
      contextTokens: STALE_CONTEXT_TOKENS + 1,
    }

    expect(shouldPromptForNewSession({ ...stale, isRunning: true })).toBe(false)
    expect(shouldPromptForNewSession({ ...stale, isAwaitingInput: true })).toBe(false)
  })
})
