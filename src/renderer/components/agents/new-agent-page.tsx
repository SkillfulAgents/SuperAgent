import { useCallback } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CreateAgentScreen } from '@renderer/components/wizard/create-agent-step'
import { useFileAgentIntoSection } from '@renderer/hooks/use-file-agent-into-section'

export function NewAgentPage() {
  const router = useRouter()
  const { from, section, surface } = useSearch({ from: '/new-agent' })
  const fileIntoSection = useFileAgentIntoSection()

  const close = useCallback(() => {
    // `from` was open-redirect-validated by the route's validateSearch. Push
    // the raw path+search so we land exactly where the button was pressed.
    router.history.push(from ?? '/')
  }, [router, from])

  const handleAgentCreated = useCallback(
    ({ slug }: { slug: string }) => fileIntoSection(slug, section),
    [fileIntoSection, section],
  )

  return (
    <CreateAgentScreen
      data-testid="new-agent-page"
      nameTitle="Name your new AI teammate"
      surface={surface}
      onIdentityCreated={handleAgentCreated}
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
