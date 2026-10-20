import { describe, expect, it } from 'vitest'
import { computeActivity, type ActivityState } from './activity'

const idle: ActivityState = {
  isActive: false,
  isAwaitingInput: false,
  isCompacting: false,
  isRetrying: false,
  isThinking: false,
  isStreaming: false,
  hasToolUse: false,
}

const active = (state: Partial<ActivityState> = {}): ActivityState => ({ ...idle, isActive: true, ...state })

describe('computeActivity', () => {
  it('reads idle for an inactive session, whatever stale flags it still carries', () => {
    expect(computeActivity(idle)).toBe('idle')
    expect(computeActivity({
      isActive: false,
      isAwaitingInput: true,
      isCompacting: true,
      isRetrying: true,
      isThinking: true,
      isStreaming: true,
      hasToolUse: true,
    })).toBe('idle')
  })

  it('reads working for an active session with nothing more specific to say', () => {
    expect(computeActivity(active())).toBe('working')
  })

  it('puts waiting on the user above every busy state', () => {
    expect(computeActivity(active({ isAwaitingInput: true, isCompacting: true, isRetrying: true, isThinking: true, isStreaming: true })))
      .toBe('awaiting')
  })

  it('ranks compacting > retrying > thinking > working', () => {
    expect(computeActivity(active({ isCompacting: true, isRetrying: true, isThinking: true, isStreaming: true }))).toBe('compacting')
    expect(computeActivity(active({ isRetrying: true, isThinking: true, isStreaming: true }))).toBe('retrying')
    expect(computeActivity(active({ isThinking: true, isStreaming: true }))).toBe('thinking')
  })

  it('reads streaming only while reply text owns the surface', () => {
    expect(computeActivity(active({ isStreaming: true }))).toBe('streaming')
  })

  it('reads working, not streaming, while a tool call is being written', () => {
    expect(computeActivity(active({ isStreaming: true, hasToolUse: true }))).toBe('working')
    expect(computeActivity(active({ hasToolUse: true }))).toBe('working')
  })

  it('never shows a stale streaming flag over a retry', () => {
    expect(computeActivity(active({ isStreaming: true, isRetrying: true }))).toBe('retrying')
  })
})
