import { useAgents } from '@renderer/hooks/use-agents'
import { useOffersCloudTeamBrain } from '@renderer/hooks/use-cloud-team-brain'
import { useTeamBrainSetup } from '@renderer/hooks/use-team-brain-setup'
import { useUser } from '@renderer/context/user-context'
import { useCloudConnection } from '@renderer/lib/team-brain/team-brain-cloud'
import { useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { useTeamBrainDevOverride } from './team-brain-dev-override'
import { TeamBrainIntro } from './team-brain-intro'
import { TeamBrainOnboarding } from './team-brain-onboarding'
import { TeamBrainCloudOverview, TeamBrainOverview } from './team-brain-overview'

/**
 * The Team Brain page: the pitch and the set-up modal over it, or once set up,
 * its home page. Admins set it up, as they make drives global. On the desktop
 * set-up can instead connect to the organization's Team Brain in its cloud
 * workspace, read-only, whose home the page then shows. One at a time: a
 * Team Brain set up here, or the cloud's.
 */
export function TeamBrainPage() {
  const tb = useTeamBrain()
  const setup = useTeamBrainSetup()
  const desktop = useOffersCloudTeamBrain()
  const cloud = useCloudConnection()
  // Dev builds can show the desktop's page over a Team Brain set up here.
  const desktopShown = useTeamBrainDevOverride().window === 'desktop'
  const { isAuthMode, isAdmin } = useUser()
  const { data: agents, isPending } = useAgents()
  const brainAgent = setup.agentSlug && agents?.find((agent) => agent.slug === setup.agentSlug)

  // After Start chat the page stays blank under the "Setting up your agent..." card.
  if (tb.state.status === 'launching') return null
  // Which page it is waits on the agents, or a reload would show the pitch for a moment before the home page.
  if (isPending) return null

  if (brainAgent && !desktopShown) return <TeamBrainOverview agent={brainAgent} />
  if (desktop && cloud.state.connected) return <TeamBrainCloudOverview brain={cloud.state.connected.brain} />

  return (
    <>
      <TeamBrainIntro onStart={isAuthMode && !isAdmin ? undefined : desktop ? tb.startOnDesktop : tb.start} />
      <TeamBrainOnboarding
        open={tb.isOnboarding}
        desktop={desktop}
        onPrepare={setup.prepare}
        onDiscard={setup.discardPrepared}
        onStartChat={setup.startChat}
        onCancel={setup.cancel}
      />
    </>
  )
}
