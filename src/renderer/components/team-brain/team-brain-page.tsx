import { useAgents } from '@renderer/hooks/use-agents'
import { useTeamBrainSetup } from '@renderer/hooks/use-team-brain-setup'
import { useUser } from '@renderer/context/user-context'
import { useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { TeamBrainIntro } from './team-brain-intro'
import { TeamBrainOnboarding } from './team-brain-onboarding'
import { TeamBrainOverview } from './team-brain-overview'

/**
 * The Team Brain page: the pitch and the set-up window over it, or once set up,
 * its home page. Admins set it up, as they make drives global. A set-up in
 * progress turns the pitch's button into Resume set-up and Discard set-up.
 */
export function TeamBrainPage() {
  const tb = useTeamBrain()
  const setup = useTeamBrainSetup()
  const { isAuthMode, isAdmin } = useUser()
  const canSetUp = !isAuthMode || isAdmin
  const { data: agents, isPending } = useAgents()
  const brainAgent = agents?.find((agent) => agent.teamBrain)

  // After Start chat the page stays blank under the "Setting up your agent..." card.
  if (tb.state.status === 'launching') return null
  // Which page it is waits on the agents and any set-up, or a reload would show the pitch for a moment before the right page.
  if (isPending || setup.isPending) return null

  if (brainAgent) return <TeamBrainOverview agent={brainAgent} />

  const inProgress = canSetUp && setup.setup
  return (
    <>
      <TeamBrainIntro
        onStart={canSetUp && !setup.setup ? setup.start : undefined}
        resume={inProgress ? {
          madeSomething: !!inProgress.agentSlug || !!inProgress.volumeId,
          onResume: setup.resume,
          onDiscard: setup.discard,
        } : undefined}
      />
      <TeamBrainOnboarding open={tb.isOnboarding} setup={setup} />
    </>
  )
}
