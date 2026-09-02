import { describe, expect, it } from 'vitest'

import { createAssistantMessage, createUserMessage } from '@renderer/test/factories'
import { latestPersistedPaywall } from './use-session-paywall'

const PAYWALL_PRESENTATION = {
  severity: 'error' as const,
  icon: 'info' as const,
  message: '**Subscription Required:** Subscribe to continue.',
  paywall: { subscriptionRequired: true },
}

describe('latestPersistedPaywall', () => {
  it('restores the paywall when the latest assistant message is a 402', () => {
    const paywall = latestPersistedPaywall([
      createUserMessage({ content: { text: 'hello' } }),
      createAssistantMessage({
        content: { text: 'API Error: 402 Workspace has insufficient balance.' },
        errorPresentation: PAYWALL_PRESENTATION,
      }),
    ])

    expect(paywall).toEqual({
      messageId: expect.any(String),
      message: 'API Error: 402 Workspace has insufficient balance.',
      presentation: PAYWALL_PRESENTATION,
    })
  })

  it('does not revive an older paywall after a later answer', () => {
    const paywall = latestPersistedPaywall([
      createAssistantMessage({
        content: { text: 'API Error: 402 Workspace has insufficient balance.' },
        errorPresentation: PAYWALL_PRESENTATION,
      }),
      createAssistantMessage({ content: { text: 'Recovered answer' } }),
    ])

    expect(paywall).toBeNull()
  })
})
