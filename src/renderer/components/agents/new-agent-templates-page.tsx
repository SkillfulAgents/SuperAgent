import { useCallback, useState } from 'react'
import { useRouter, useSearch } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { CreateAgentChrome } from '@renderer/components/wizard/create-agent-step'
import { CreateAgentTemplates } from '@renderer/components/agents/create-agent-templates'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { ImportAgentDialog } from '@renderer/components/agents/import-agent-dialog'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import { useFileAgentIntoSection } from '@renderer/hooks/use-file-agent-into-section'
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'

/**
 * The New Agent menu's Browse Templates (`/new-agent/templates`): the
 * template roster the onboarding wizard shows under its composer, as a page
 * of its own. A card opens the install dialog; installing opens the agent
 * (or its onboarding session). Back and the X return to `?from=`.
 */
export function NewAgentTemplatesPage() {
  const router = useRouter()
  const { from, section, surface } = useSearch({ from: '/new-agent/templates' })
  const completeInstall = useCompleteTemplateInstall()
  const fileIntoSection = useFileAgentIntoSection()
  const [template, setTemplate] = useState<ApiDiscoverableAgent | null>(null)
  const [importing, setImporting] = useState(false)

  const close = useCallback(() => {
    // `from` was open-redirect-validated by the route's validateSearch.
    router.history.push(from ?? '/')
  }, [router, from])

  const finish = useCallback(
    async (agent: ApiAgentTemplateInstallResult, source: 'skillset' | 'import') => {
      await completeInstall(agent, { source, surface })
      await fileIntoSection(agent.slug, section)
    },
    [completeInstall, fileIntoSection, section, surface],
  )

  return (
    <CreateAgentChrome
      data-testid="new-agent-templates-page"
      onClose={close}
      footer={(
        <Button variant="outline" onClick={close} data-testid="new-agent-back">
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <CreateAgentTemplates
          standalone
          onSelect={setTemplate}
          onImportClick={() => setImporting(true)}
        />
      </div>

      <TemplateInstallDialog
        template={template}
        onClose={() => setTemplate(null)}
        onInstalled={(agent) => finish(agent, 'skillset')}
      />
      <ImportAgentDialog
        open={importing}
        onClose={() => setImporting(false)}
        onComplete={(agent) => finish(agent, 'import')}
      />
    </CreateAgentChrome>
  )
}
