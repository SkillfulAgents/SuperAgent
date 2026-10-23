import { useAgents } from '@renderer/hooks/use-agents'
import { useTeamBrainSetup } from '@renderer/hooks/use-team-brain-setup'
import { useUser } from '@renderer/context/user-context'
import { useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { TeamBrainIntro } from './team-brain-intro'
import { TeamBrainOnboarding } from './team-brain-onboarding'
import { TeamBrainOverview } from './team-brain-overview'

/**
 * The Team Brain page: the pitch and the set-up modal over it, or once set up,
 * its home page. Admins set it up, as they make drives global.
 */
export function TeamBrainPage() {
  const tb = useTeamBrain()
  const setup = useTeamBrainSetup()
  const { isAuthMode, isAdmin } = useUser()
  const { data: agents, isPending } = useAgents()
  const brainAgent = setup.agentSlug && agents?.find((agent) => agent.slug === setup.agentSlug)

  // After Start chat the page stays blank under the "Setting up your agent..." card.
  if (tb.state.status === 'launching') return null
  // Which page it is waits on the agents, or a reload would show the pitch for a moment before the home page.
  if (isPending) return null

  if (brainAgent) return <TeamBrainOverview agent={brainAgent} />

  return (
    <>
      <TeamBrainIntro onStart={isAuthMode && !isAdmin ? undefined : tb.start} />
      <TeamBrainOnboarding open={tb.isOnboarding} onPrepare={setup.prepare} onStartChat={setup.startChat} onCancel={setup.cancel} />
    </>
  )
}
