// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
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
  it('keeps one initiating session and drops expired or malformed records', () => {
    rememberBillingResumeTarget({ agentSlug: 'agent-1', sessionId: 'session-1' })
    const second = rememberBillingResumeTarget({ agentSlug: 'agent-2', sessionId: 'session-2' })
    expect(getBillingResumeTarget()).toEqual(second)

    vi.setSystemTime(new Date('2026-09-01T12:31:00.000Z'))
    expect(getBillingResumeTarget()).toBeNull()

    sessionStorage.setItem('superagent.billing-resume', '{not-json')
    expect(getBillingResumeTarget()).toBeNull()
  })
})
