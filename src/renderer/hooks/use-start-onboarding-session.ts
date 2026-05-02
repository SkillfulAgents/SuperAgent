import { useCallback } from 'react'
import { useCreateSession } from '@renderer/hooks/use-sessions'
import { useSelection } from '@renderer/context/selection-context'

const ONBOARDING_MESSAGE =
  'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

/**
 * Kicks off the onboarding session for a freshly imported agent.
 * Failures are swallowed — the agent is still usable without it.
 */
export function useStartOnboardingSession() {
  const createSession = useCreateSession()
  const { selectSession } = useSelection()

  return useCallback(
    async (agentSlug: string) => {
      try {
        const session = await createSession.mutateAsync({
          agentSlug,
          message: ONBOARDING_MESSAGE,
        })
        selectSession(session.id)
      } catch {
        // Onboarding session creation failed — user can still use agent normally
      }
    },
    [createSession, selectSession],
  )
}
