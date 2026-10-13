import { describe, expect, it, vi } from 'vitest'
import type { DraftsStore } from '@renderer/context/drafts-context'
import { completeAgentTemplateHandoff } from './agent-template-handoff'

describe('completeAgentTemplateHandoff', () => {
  it('seeds a template prompt and suppresses the auto-started onboarding session', async () => {
    const order: string[] = []
    const draftsStore: Pick<DraftsStore, 'update'> = {
      update(key, patch) {
        order.push(`update:${key}:${patch.text}`)
      },
    }
    const noteProgrammaticChange = vi.fn((prompt: string) => order.push(`baseline:${prompt}`))
    const openAgent = vi.fn(() => { order.push('open') })
    const startOnboardingSession = vi.fn()

    await completeAgentTemplateHandoff({
      draftsStore,
      agentSlug: 'new-agent',
      hasOnboarding: true,
      templatePrompt: 'Start with this task',
      noteProgrammaticChange,
      openAgent,
      startOnboardingSession,
    })

    expect(order).toEqual([
      'baseline:Start with this task',
      'update:agent:new-agent:Start with this task',
      'open',
    ])
    expect(startOnboardingSession).not.toHaveBeenCalled()
  })

  it('starts onboarding after opening the agent when no template prompt exists', async () => {
    const order: string[] = []
    const startOnboardingSession = vi.fn(() => { order.push('onboarding') })

    await completeAgentTemplateHandoff({
      draftsStore: { update: vi.fn() },
      agentSlug: 'new-agent',
      hasOnboarding: true,
      openAgent: () => { order.push('open') },
      startOnboardingSession,
    })

    expect(order).toEqual(['open', 'onboarding'])
    expect(startOnboardingSession).toHaveBeenCalledWith('new-agent', undefined)
  })

  it('passes the onboarding first_prompt through when starting the session', async () => {
    const startOnboardingSession = vi.fn()

    await completeAgentTemplateHandoff({
      draftsStore: { update: vi.fn() },
      agentSlug: 'new-agent',
      hasOnboarding: true,
      onboardingFirstPrompt: 'Walk me through HubSpot',
      openAgent: vi.fn(),
      startOnboardingSession,
    })

    expect(startOnboardingSession).toHaveBeenCalledWith('new-agent', 'Walk me through HubSpot')
  })
})
