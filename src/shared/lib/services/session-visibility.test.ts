import { describe, it, expect } from 'vitest'
import { isHiddenAutomatedSession, isNoninteractiveSession } from './session-visibility'

describe('isNoninteractiveSession', () => {
  it('is false for missing metadata', () => {
    expect(isNoninteractiveSession(undefined)).toBe(false)
    expect(isNoninteractiveSession(null)).toBe(false)
  })

  it('follows the explicit flag when present', () => {
    expect(isNoninteractiveSession({ noninteractive: true })).toBe(true)
    expect(isNoninteractiveSession({ noninteractive: false, isScheduledExecution: true })).toBe(false)
  })

  it('is false for chat-integration and x-agent sessions even when the flag is absent', () => {
    expect(isNoninteractiveSession({ isChatIntegrationSession: true })).toBe(false)
    expect(isNoninteractiveSession({ invokedByAgentSlug: 'caller-agent' })).toBe(false)
  })

  it('derives the flag for rows written before it existed', () => {
    expect(isNoninteractiveSession({ isScheduledExecution: true })).toBe(true)
    expect(isNoninteractiveSession({ isWebhookExecution: true })).toBe(true)
    expect(isNoninteractiveSession({ isWidgetRepair: true })).toBe(true)
    expect(isNoninteractiveSession({ isScheduledExecution: true, promotedToInteractive: true })).toBe(false)
    expect(isNoninteractiveSession({ name: 'My session' })).toBe(false)
  })
})

describe('isHiddenAutomatedSession', () => {
  it.each([
    { isAgentIntegrationSession: true }, { agentIntegrationId: 'integration' },
    { isChatIntegrationSession: true }, { chatIntegrationId: 'legacy' },
  ])('hides all integration sessions, including legacy metadata, until explicitly promoted (%j)', metadata => {
    expect(isHiddenAutomatedSession(metadata)).toBe(true)
    expect(isHiddenAutomatedSession({ ...metadata, promotedToInteractive: true })).toBe(false)
  })

  it('is false for missing metadata (unknown sessions are treated as interactive)', () => {
    expect(isHiddenAutomatedSession(undefined)).toBe(false)
    expect(isHiddenAutomatedSession(null)).toBe(false)
  })

  it('is false for a plain interactive session', () => {
    expect(isHiddenAutomatedSession({ name: 'My session' })).toBe(false)
  })

  it('is true for a noninteractive session and for each own-flag hidden kind', () => {
    expect(isHiddenAutomatedSession({ noninteractive: true })).toBe(true)
    expect(isHiddenAutomatedSession({ isScheduledExecution: true })).toBe(true)
    expect(isHiddenAutomatedSession({ isWebhookExecution: true })).toBe(true)
    expect(isHiddenAutomatedSession({ isWidgetRepair: true })).toBe(true)
    expect(isHiddenAutomatedSession({ isChatIntegrationSession: true })).toBe(true)
    expect(isHiddenAutomatedSession({ invokedByAgentSlug: 'caller-agent' })).toBe(true)
  })

  it('is false once a noninteractive session is promoted (flag cleared)', () => {
    expect(isHiddenAutomatedSession({ noninteractive: false, isScheduledExecution: true })).toBe(false)
    expect(isHiddenAutomatedSession({ noninteractive: false, isWidgetRepair: true })).toBe(false)
  })

  it('is false once a legacy or own-flag session is promoted', () => {
    expect(isHiddenAutomatedSession({ isScheduledExecution: true, promotedToInteractive: true })).toBe(false)
    expect(isHiddenAutomatedSession({ isChatIntegrationSession: true, promotedToInteractive: true })).toBe(false)
    expect(isHiddenAutomatedSession({ invokedByAgentSlug: 'caller-agent', promotedToInteractive: true })).toBe(false)
  })

  it('an x-agent session is hidden but not noninteractive', () => {
    const meta = { invokedByAgentSlug: 'caller-agent', noninteractive: false }
    expect(isHiddenAutomatedSession(meta)).toBe(true)
    expect(isNoninteractiveSession(meta)).toBe(false)
  })

  it('does not hide a forked session (forks are user sessions, not automation)', () => {
    expect(isHiddenAutomatedSession({ name: 'Pricing (fork)', forkedFromSessionId: 'src-1' })).toBe(false)
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
