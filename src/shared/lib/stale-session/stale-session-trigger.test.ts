import { describe, it, expect } from 'vitest'
import { evaluateStalePrompt } from './stale-session-trigger'
import { STALE_TIME_GAP_MS, STALE_CONTEXT_TOKENS } from './stale-session-config'

const base = { idleMs: 0, contextTokens: 0, isAwaitingInput: false, isRunning: false }

const stale = { idleMs: STALE_TIME_GAP_MS + 1, contextTokens: STALE_CONTEXT_TOKENS + 1 }

describe('evaluateStalePrompt', () => {
  it('does not prompt a fresh, small, active session', () => {
    expect(evaluateStalePrompt(base).shouldPrompt).toBe(false)
  })
  it('does NOT prompt on idle alone when the context is small', () => {
    expect(evaluateStalePrompt({ ...base, idleMs: STALE_TIME_GAP_MS + 1 }).shouldPrompt).toBe(false)
  })
  it('does NOT prompt on size alone when recently active', () => {
    expect(evaluateStalePrompt({ ...base, contextTokens: STALE_CONTEXT_TOKENS + 1 }).shouldPrompt).toBe(false)
  })
  it('prompts only when BOTH idle past the gap AND large', () => {
    expect(evaluateStalePrompt({ ...base, ...stale }).shouldPrompt).toBe(true)
  })
  it('suppresses while awaiting a permission/tool decision, even when stale', () => {
    expect(evaluateStalePrompt({ ...base, ...stale, isAwaitingInput: true }).shouldPrompt).toBe(false)
  })
  it('suppresses while actively running', () => {
    expect(evaluateStalePrompt({ ...base, ...stale, isRunning: true }).shouldPrompt).toBe(false)
  })
})
