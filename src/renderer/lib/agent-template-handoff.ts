import type { DraftsStore } from '@renderer/context/drafts-context'
import { seedAgentTemplatePrompt } from '@renderer/context/drafts-context'

interface CompleteAgentTemplateHandoffOptions {
  draftsStore: Pick<DraftsStore, 'set'>
  agentSlug: string
  hasOnboarding?: boolean
  templatePrompt?: string
  onboardingFirstPrompt?: string
  /** Update a surviving composer's baseline before its draft changes. */
  noteProgrammaticChange?: (prompt: string) => void
  openAgent: () => void | Promise<void>
  startOnboardingSession: (agentSlug: string, firstPrompt?: string) => void | Promise<void>
}

/**
 * Hand a newly installed agent to the UI. A template prompt is authoritative:
 * it seeds the composer and suppresses the auto-started onboarding session.
 */
export async function completeAgentTemplateHandoff({
  draftsStore,
  agentSlug,
  hasOnboarding,
  templatePrompt,
  onboardingFirstPrompt,
  noteProgrammaticChange,
  openAgent,
  startOnboardingSession,
}: CompleteAgentTemplateHandoffOptions): Promise<void> {
  if (templatePrompt) noteProgrammaticChange?.(templatePrompt)
  const hasTemplatePrompt = seedAgentTemplatePrompt(draftsStore, agentSlug, templatePrompt)
  await openAgent()
  if (!hasTemplatePrompt && hasOnboarding) {
    await startOnboardingSession(agentSlug, onboardingFirstPrompt)
  }
}
