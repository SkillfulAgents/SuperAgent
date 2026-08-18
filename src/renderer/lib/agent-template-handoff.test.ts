import { describe, expect, it, vi } from 'vitest'
import type { DraftsStore } from '@renderer/context/drafts-context'
import { completeAgentTemplateHandoff } from './agent-template-handoff'

describe('completeAgentTemplateHandoff', () => {
  it('seeds a template prompt and suppresses the auto-started onboarding session', async () => {
    const order: string[] = []
    const draftsStore: Pick<DraftsStore, 'set'> = {
      set<T>(key: string, value: T | undefined): void {
        order.push(`set:${key}:${String(value)}`)
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
      'set:agent:new-agent:Start with this task',
      'open',
    ])
    expect(startOnboardingSession).not.toHaveBeenCalled()
  })

  it('starts onboarding after opening the agent when no template prompt exists', async () => {
    const order: string[] = []
    const startOnboardingSession = vi.fn(() => { order.push('onboarding') })

    await completeAgentTemplateHandoff({
      draftsStore: { set: vi.fn() as Pick<DraftsStore, 'set'>['set'] },
      agentSlug: 'new-agent',
      hasOnboarding: true,
      openAgent: () => { order.push('open') },
      startOnboardingSession,
    })

    expect(order).toEqual(['open', 'onboarding'])
    expect(startOnboardingSession).toHaveBeenCalledWith('new-agent')
  })
})
