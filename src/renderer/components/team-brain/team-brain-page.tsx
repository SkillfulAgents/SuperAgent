import { toast } from 'sonner'
import { useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { TeamBrainIntro } from './team-brain-intro'
import { TeamBrainOnboarding } from './team-brain-onboarding'

/**
 * The Team Brain page before anyone has set it up: the pitch, and the set-up
 * modal over it. The modal's last step hands over to a chat with Team Brain,
 * which comes in a later change; until then it closes the modal and says so.
 */
export function TeamBrainPage() {
  const tb = useTeamBrain()
  const startChat = () => {
    tb.cancelSetup()
    toast('The set-up chat is coming soon', { description: 'This first version of Team Brain stops at the set-up modal.' })
  }
  return (
    <>
      <TeamBrainIntro onStart={tb.start} />
      <TeamBrainOnboarding open={tb.isOnboarding} onStartChat={startChat} />
    </>
  )
}
