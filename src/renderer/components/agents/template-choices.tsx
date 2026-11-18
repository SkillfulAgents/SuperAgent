import { useState } from 'react'
import type { CreateAgentSurface } from '@renderer/router/search-schemas'
import { CreateAgentTemplates } from '@renderer/components/agents/create-agent-templates'
import { TemplateInstallDialog } from '@renderer/components/agents/template-install-dialog'
import { ImportAgentDialog } from '@renderer/components/agents/import-agent-dialog'
import { useCompleteTemplateInstall } from '@renderer/hooks/use-complete-template-install'
import type { ApiAgentTemplateInstallResult, ApiDiscoverableAgent } from '@shared/lib/types/api'

export function TemplateChoices({ initiallyImporting, surface, onInstalled, onNavigateAway }: {
  initiallyImporting?: boolean
  surface?: CreateAgentSurface
  onInstalled: (agent: ApiAgentTemplateInstallResult) => void | Promise<void>
  onNavigateAway?: () => void | Promise<void>
}) {
  const completeInstall = useCompleteTemplateInstall()
  const [template, setTemplate] = useState<ApiDiscoverableAgent | null>(null)
  const [importing, setImporting] = useState(!!initiallyImporting)
  async function finish(agent: ApiAgentTemplateInstallResult, source: 'skillset' | 'import') {
    await completeInstall(agent, { source, surface })
    await onInstalled(agent)
  }
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <CreateAgentTemplates
          standalone
          onNavigateAway={onNavigateAway}
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
    </>
  )
}
