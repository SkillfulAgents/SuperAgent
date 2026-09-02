// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearBillingResumeTarget,
  getBillingResumeTarget,
  rememberBillingResumeTarget,
  resetBillingResumeTargetForTests,
} from './billing-resume-target'

beforeEach(() => {
  resetBillingResumeTargetForTests()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  resetBillingResumeTargetForTests()
})

describe('billing resume target', () => {
  it('persists a single initiating session with an attempt id', () => {
    const first = rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    expect(first.attemptId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.initialAllowed).toBe(false)
    expect(getBillingResumeTarget()).toEqual(first)

    const second = rememberBillingResumeTarget({ agentSlug: 'agent-2', sessionId: 'session-2' })
    expect(getBillingResumeTarget()).toEqual(second)
    expect(getBillingResumeTarget()?.sessionId).toBe('session-2')
  })

  it('survives a renderer reload via sessionStorage', () => {
    const stored = rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    resetBillingResumeTargetForTests()
    sessionStorage.setItem('superagent.billing-resume', JSON.stringify(stored))
    expect(getBillingResumeTarget()).toEqual(stored)
  })

  it('drops an expired or malformed record', () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    vi.setSystemTime(new Date('2026-09-01T12:31:00.000Z'))
    expect(getBillingResumeTarget()).toBeNull()

    sessionStorage.setItem('superagent.billing-resume', '{not-json')
    expect(getBillingResumeTarget()).toBeNull()
  })

  it('clears only the matching session', () => {
    const target = rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    clearBillingResumeTarget({ agentSlug: 'other', sessionId: 'session-1' })
    expect(getBillingResumeTarget()?.attemptId).toBe(target.attemptId)
    clearBillingResumeTarget(target)
    expect(getBillingResumeTarget()).toBeNull()
  })
})
