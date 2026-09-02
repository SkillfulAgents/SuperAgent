import { beforeEach, describe, expect, it } from 'vitest'

import {
  beginBillingResumeAttempt,
  finishBillingResumeAttempt,
  resetBillingResumeAttemptsForTests,
} from './billing-resume-attempts'

describe('billing resume attempts', () => {
  beforeEach(() => resetBillingResumeAttemptsForTests())

  it('scopes duplicate attempt ids to their session', () => {
    expect(beginBillingResumeAttempt('attempt-1', 'session-1', 0)).toEqual({ ok: true })
    finishBillingResumeAttempt('attempt-1', 'session-1', true, 0)

    expect(beginBillingResumeAttempt('attempt-1', 'session-1', 1)).toEqual({
      ok: false,
      duplicate: true,
    })
    expect(beginBillingResumeAttempt('attempt-1', 'session-2', 1)).toEqual({ ok: true })
  })

  it('expires completed attempts after the resume target lifetime', () => {
    expect(beginBillingResumeAttempt('attempt-1', 'session-1', 0)).toEqual({ ok: true })
    finishBillingResumeAttempt('attempt-1', 'session-1', true, 0)

    expect(beginBillingResumeAttempt('attempt-1', 'session-1', 30 * 60 * 1000 + 1)).toEqual({
      ok: true,
    })
  })

  it('bounds completed attempt history', () => {
    for (let i = 0; i <= 1000; i++) {
      const attemptId = `attempt-${i}`
      expect(beginBillingResumeAttempt(attemptId, 'session-1', i)).toEqual({ ok: true })
      finishBillingResumeAttempt(attemptId, 'session-1', true, i)
    }

    expect(beginBillingResumeAttempt('attempt-0', 'session-1', 1002)).toEqual({ ok: true })
  })
})
