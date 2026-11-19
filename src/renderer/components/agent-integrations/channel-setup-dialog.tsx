import { useEffect } from 'react'
import { channelSetupComplete, type PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { AgentIntegrationSetupDialog, DeferChannelButton } from './agent-integration-setup-dialog'
import { ProvisionedAppCard } from './provisioned-app-card'
import type { IntegrationSetupProvider } from './setup-types'

export interface ChannelSetupTarget {
  provider: IntegrationSetupProvider
  integrationId?: string
}

export function channelSetupTarget(provider: IntegrationSetupProvider, integrations?: PublicAgentIntegration[]): ChannelSetupTarget {
  const existing = integrations?.find(row =>
    row.provider === provider.slug && !channelSetupComplete(row) && (row.provisionedApp || provider.ConnectionSettings))
  return { provider, integrationId: existing?.id }
}

/** Capture the installation on open: a new multi-step form keeps its place when it creates its first record. */
export function ChannelSetupDialog({ agentSlug, target, integrations, onClose }: {
  agentSlug: string
  target: ChannelSetupTarget
  integrations?: PublicAgentIntegration[]
  onClose: () => void
}) {
  const { provider, integrationId } = target
  const integration = integrations?.find(row => row.id === integrationId)
  const finished = integration && channelSetupComplete(integration)
  useEffect(() => {
    if (integrationId && integrations && (!integration || finished)) onClose()
  }, [integrationId, integrations, integration, finished, onClose])

  if (!integrationId) return <AgentIntegrationSetupDialog agentSlug={agentSlug} provider={provider}
    allowDefer onIntegrationCreated={onClose} onOpenChange={open => { if (!open) onClose() }} />

  if (!integration || finished) return null
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogTitle>Finish {provider.label} setup</DialogTitle>
      {integration.provisionedApp
        ? <ProvisionedAppCard integration={integration} />
        : provider.ConnectionSettings && <provider.ConnectionSettings integration={integration} />}
      <DeferChannelButton agentSlug={agentSlug} provider={provider.slug} onClose={onClose} />
    </DialogContent>
  </Dialog>
}
