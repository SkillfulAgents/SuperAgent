import { useCallback } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CreateAgentScreen } from '@renderer/components/wizard/create-agent-step'
import { useFileAgentIntoSection } from '@renderer/hooks/use-file-agent-into-section'

/**
 * The from-scratch create page (`/new-agent`), the New Agent menu's From
 * Scratch: the onboarding wizard's create step without its template roster
 * (templates have their own page, `/new-agent/templates`). Name and orb, then
 * the job, then add-ons. Creating navigates on to the new agent; Back steps
 * back, then returns to `?from=`; the X leaves at once.
 */
export function NewAgentPage() {
  const router = useRouter()
  const { from, section, surface } = useSearch({ from: '/new-agent' })
  const fileIntoSection = useFileAgentIntoSection()

  const close = useCallback(() => {
    // `from` was open-redirect-validated by the route's validateSearch. Push
    // the raw path+search so we land exactly where the button was pressed.
    router.history.push(from ?? '/')
  }, [router, from])

  // The form has already navigated to the agent by now; a section's + files
  // it into that section.
  const handleAgentCreated = useCallback(
    ({ slug }: { slug: string }) => fileIntoSection(slug, section),
    [fileIntoSection, section],
  )

  return (
    <CreateAgentScreen
      data-testid="new-agent-page"
      nameTitle="Name your new AI teammate"
      surface={surface}
      showTemplates={false}
      onAgentCreated={handleAgentCreated}
      onClose={close}
      footer={(flow) => (
        // A step back while there is one; from the first step it leaves.
        <Button
          variant="outline"
          onClick={() => { if (!flow.back()) close() }}
          data-testid="new-agent-back"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      )}
    />
  )
}
