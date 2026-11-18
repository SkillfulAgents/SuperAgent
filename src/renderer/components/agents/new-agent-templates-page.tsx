import { useCallback } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CreateAgentChrome } from '@renderer/components/wizard/create-agent-step'
import { TemplateChoices } from './template-choices'
import { useFileAgentIntoSection } from '@renderer/hooks/use-file-agent-into-section'

export function NewAgentTemplatesPage() {
  const router = useRouter()
  const { from, section, surface, importing } = useSearch({ from: '/new-agent/templates' })
  const fileIntoSection = useFileAgentIntoSection()
  const close = useCallback(() => {
    // `from` was open-redirect-validated by the route's validateSearch.
    router.history.push(from ?? '/')
  }, [router, from])

  return (
    <CreateAgentChrome
      data-testid="new-agent-templates-page"
      onClose={close}
      footer={(
        <Button variant="outline" onClick={() => void router.navigate({ to: '/new-agent', search: { from, section, surface }, replace: true })} data-testid="new-agent-back">
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      )}
    >
      <TemplateChoices initiallyImporting={importing} surface={surface} onInstalled={(agent) => fileIntoSection(agent.slug, section)} />
    </CreateAgentChrome>
  )
}
