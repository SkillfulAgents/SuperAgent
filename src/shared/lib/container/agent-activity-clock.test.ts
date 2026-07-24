import { describe, it, expect, beforeEach } from 'vitest'
import {
  touchAgentActivity,
  getAgentLastActivity,
  clearAgentActivity,
  clearAllAgentActivity,
} from './agent-activity-clock'

describe('agent-activity-clock', () => {
  beforeEach(() => {
    clearAllAgentActivity()
  })

  it('touch then get returns the timestamp', () => {
    touchAgentActivity('a1', 1000)
    expect(getAgentLastActivity('a1')).toBe(1000)
  })

  it('touch only advances (ignores older timestamps)', () => {
    touchAgentActivity('a1', 2000)
    touchAgentActivity('a1', 1000)
    expect(getAgentLastActivity('a1')).toBe(2000)
  })

  it('clear removes one agent', () => {
    touchAgentActivity('a1', 1000)
    touchAgentActivity('a2', 2000)
    clearAgentActivity('a1')
    expect(getAgentLastActivity('a1')).toBeUndefined()
    expect(getAgentLastActivity('a2')).toBe(2000)
  })

  it('clearAll removes every agent', () => {
    touchAgentActivity('a1', 1000)
    touchAgentActivity('a2', 2000)
    clearAllAgentActivity()
    expect(getAgentLastActivity('a1')).toBeUndefined()
    expect(getAgentLastActivity('a2')).toBeUndefined()
  })
})
