import { useAgents } from '@renderer/hooks/use-agents'
import { useTeamBrainSetup } from '@renderer/hooks/use-team-brain-setup'
import { useUser } from '@renderer/context/user-context'
import { useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { AppLink } from '@renderer/components/ui/app-link'
import { TeamBrainIntro } from './team-brain-intro'
import { TeamBrainOnboarding } from './team-brain-onboarding'

/**
 * The Team Brain page: the pitch and the set-up modal over it, or once set up,
 * the way to its agent. Admins set it up, as they make drives global.
 */
export function TeamBrainPage() {
  const tb = useTeamBrain()
  const setup = useTeamBrainSetup()
  const { isAuthMode, isAdmin } = useUser()
  const { data: agents } = useAgents()
  const brainAgent = setup.agentSlug && agents?.find((agent) => agent.slug === setup.agentSlug)

  // After Start chat the page stays blank under the "Setting up your agent..." card.
  if (tb.state.status === 'launching') return null

  if (brainAgent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground" data-testid="team-brain-ready">
        <p>Team Brain is set up.</p>
        <AppLink to="/agents/$slug" params={{ slug: brainAgent.displaySlug }} className="text-foreground underline underline-offset-2">
          Open Team Brain
        </AppLink>
      </div>
    )
  }

  return (
    <>
      <TeamBrainIntro onStart={isAuthMode && !isAdmin ? undefined : tb.start} />
      <TeamBrainOnboarding open={tb.isOnboarding} onPrepare={setup.prepare} onStartChat={setup.startChat} onCancel={setup.cancel} />
    </>
  )
}
