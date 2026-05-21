import { useCallback } from 'react'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'
import { useOnboarding } from '@renderer/context/onboarding-context'

const ONBOARDING_MESSAGE =
  'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

/**
 * Kicks off the onboarding session for a freshly imported agent.
 * Failures are swallowed — the agent is still usable without it.
 *
 * Loading state is managed via OnboardingContext so the spinner dialog
 * persists across component unmounts/remounts during navigation.
 */
export function useStartOnboardingSession() {
  const createSession = useCreateSession()
  const { setView } = useSelection()
  const { setOnboarding } = useOnboarding()

  return useCallback(
    async (agentSlug: string) => {
      setOnboarding(true)
      try {
        const session = await createSession.mutateAsync({
          agentSlug,
          message: ONBOARDING_MESSAGE,
        })
        setView({ kind: 'session', id: session.id })
      } catch {
        // Onboarding session creation failed — user can still use agent normally
      } finally {
        setOnboarding(false)
      }
    },
    [createSession, setView, setOnboarding],
  )
}
