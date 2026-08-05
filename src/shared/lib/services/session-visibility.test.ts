import { describe, it, expect } from 'vitest'
import { isHiddenAutomatedSession } from './session-visibility'

describe('isHiddenAutomatedSession', () => {
  it('is false for missing metadata (unknown sessions are treated as interactive)', () => {
    expect(isHiddenAutomatedSession(undefined)).toBe(false)
    expect(isHiddenAutomatedSession(null)).toBe(false)
  })

  it('is false for a plain interactive session', () => {
    expect(isHiddenAutomatedSession({ name: 'My session' })).toBe(false)
  })

  it('is true for each automation kind', () => {
    expect(isHiddenAutomatedSession({ isScheduledExecution: true })).toBe(true)
    expect(isHiddenAutomatedSession({ isWebhookExecution: true })).toBe(true)
    expect(isHiddenAutomatedSession({ isChatIntegrationSession: true })).toBe(true)
  })

  it('is false once the session is promoted to interactive', () => {
    expect(isHiddenAutomatedSession({ isScheduledExecution: true, promotedToInteractive: true })).toBe(false)
    expect(isHiddenAutomatedSession({ isChatIntegrationSession: true, promotedToInteractive: true })).toBe(false)
  })

  it('is false when automation flags are explicitly false', () => {
    expect(
      isHiddenAutomatedSession({
        isScheduledExecution: false,
        isWebhookExecution: false,
        isChatIntegrationSession: false,
      }),
    ).toBe(false)
  })
})
