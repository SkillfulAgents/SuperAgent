import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { channelSetupComplete } from '@shared/lib/agent-integrations/public'
import { ChannelAction } from '@renderer/components/agent-integrations/channel-action'
import { ChannelSetupDialog, channelSetupTarget, type ChannelSetupTarget } from '@renderer/components/agent-integrations/channel-setup-dialog'
import { useFinishedSetup } from '@renderer/hooks/use-finished-setup'
import { integrationSetupProviders } from '@renderer/components/agent-integrations/setup-providers'
import type { IntegrationSetupProvider } from '@renderer/components/agent-integrations/setup-types'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useAgentIntegrations, useAvailableAgentIntegrationProviders } from '@renderer/hooks/use-agent-integrations'

const featured = integrationSetupProviders.filter(p => p.slug === 'platform-email' || p.slug === 'slack')
const moreChannels = integrationSetupProviders.filter(provider => !featured.includes(provider))

export function AgentCreationChannels({ agentSlug }: { agentSlug: string }) {
  const providers = useAvailableAgentIntegrationProviders()
  const integrations = useAgentIntegrations(agentSlug)
  const [expanded, setExpanded] = useState(false)
  const moreId = useId()
  const [target, setTarget] = useState<ChannelSetupTarget | null>(null)
  const { data: deferred } = useFinishedSetup(agentSlug)

  function channelRow(provider: IntegrationSetupProvider) {
    const inbox = provider.slug === 'platform-email'
    const title = inbox ? 'Inbox' : provider.label
    const rows = integrations.data?.filter(row => row.provider === provider.slug)
    const configured = rows?.some(channelSetupComplete)
    const setupTarget = channelSetupTarget(provider, rows)
    const saved = deferred?.steps.some(step => step.provider === provider.slug)
    const action = configured ? 'Configured' : setupTarget.integrationId || saved ? 'Finish setup' : 'Set up'
    let reason: string | undefined
    if (configured) {
      reason = `${title} is already set up for this agent.`
    } else if (!setupTarget.integrationId) {
      if (!providers.data || !integrations.data) {
        reason = providers.isError || integrations.isError ? 'Could not load channels.' : 'Checking available channels…'
      } else if (!providers.data.some(p => p.provider === provider.slug)) {
        reason = provider.unavailableReason ?? `${title} is unavailable in this workspace.`
      }
    }
    return <div key={provider.slug} className="flex items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground [&_svg]:size-4" aria-hidden>
        <ServiceIcon slug={provider.slug} fallback="mcp" className={provider.iconClassName} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{provider.description}</p>
      </div>
      <ChannelAction action={action} title={title} reason={reason} onSetup={() => setTarget(setupTarget)} />
    </div>
  }

  return <>
    {featured.map(channelRow)}
    <button type="button" aria-label="More channels" aria-expanded={expanded} aria-controls={moreId}
      className="flex w-full items-center justify-between gap-3 rounded-b-card px-4 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-expanded:rounded-none"
      onClick={() => setExpanded(open => !open)}>
      More
      <ChevronDown aria-hidden className={`size-4 ${expanded ? 'rotate-180' : ''}`} />
    </button>
    <div id={moreId} hidden={!expanded} className="divide-y">{expanded && moreChannels.map(channelRow)}</div>
    {target && <ChannelSetupDialog agentSlug={agentSlug} target={target} integrations={integrations.data} onClose={() => {
      setTarget(null)
      void integrations.refetch()
    }} />}
  </>
}
