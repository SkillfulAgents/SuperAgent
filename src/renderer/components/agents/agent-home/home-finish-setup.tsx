import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { channelSetupComplete } from '@shared/lib/agent-integrations/public'
import type { FinishedSetup } from '@shared/lib/agent-integrations/finished-setup-schema'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { ChannelAction } from '@renderer/components/agent-integrations/channel-action'
import { ChannelSetupDialog, channelSetupTarget, type ChannelSetupTarget } from '@renderer/components/agent-integrations/channel-setup-dialog'
import { integrationSetupProviders } from '@renderer/components/agent-integrations/setup-providers'
import { useAgentIntegrations, useAvailableAgentIntegrationProviders } from '@renderer/hooks/use-agent-integrations'
import { useFinishedSetup, useSetChannelDeferred } from '@renderer/hooks/use-finished-setup'
import { HomeGlassPanel } from './home-glass-panel'

export function HomeFinishSetup({ agentSlug, isOwner }: { agentSlug: string; isOwner: boolean }) {
  const notes = useFinishedSetup(agentSlug)
  if (!notes.data?.steps.length) return null
  return <PendingChannels agentSlug={agentSlug} isOwner={isOwner} steps={notes.data.steps} refresh={notes.refetch} />
}

function PendingChannels({ agentSlug, isOwner, steps, refresh }: {
  agentSlug: string
  isOwner: boolean
  steps: FinishedSetup['steps']
  refresh: () => Promise<unknown>
}) {
  const [target, setTarget] = useState<ChannelSetupTarget | null>(null)
  const integrations = useAgentIntegrations(agentSlug)
  const available = useAvailableAgentIntegrationProviders()
  const dismiss = useSetChannelDeferred(agentSlug)
  const complete = new Set(integrations.data?.filter(channelSetupComplete).map(row => row.provider))
  const hasCompletedStep = steps.some(step => complete.has(step.provider))
  // The integrations list also polls for installations finished in another window.
  useEffect(() => {
    if (hasCompletedStep) void refresh()
  }, [hasCompletedStep, refresh])

  const rows = steps.flatMap(step => {
    const provider = integrationSetupProviders.find(p => p.slug === step.provider)
    if (!provider || complete.has(provider.slug) || (provider.managementAccess === 'owner' && !isOwner)) return []
    return [provider]
  })
  if (!rows.length) return null

  return (
    <HomeGlassPanel title="Finish setting up this agent">
      <div className="divide-y">
        {rows.map(provider => {
          const label = provider.slug === 'platform-email' ? 'Inbox' : provider.label
          const setup = channelSetupTarget(provider, integrations.data)
          let reason: string | undefined
          if (!integrations.data || (!setup.integrationId && !available.data)) {
            reason = integrations.isError || available.isError ? 'Could not load channels.' : 'Checking available channels…'
          } else if (!setup.integrationId && !available.data?.some(p => p.provider === provider.slug)) {
            reason = provider.unavailableReason ?? `${label} is unavailable in this workspace.`
          }
          return (
            <div key={provider.slug} className="flex items-center gap-2 py-2">
              <ServiceIcon slug={provider.slug} fallback="mcp" className={`size-4 shrink-0 ${provider.iconClassName ?? ''}`} />
              <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
              <ChannelAction action="Finish setup" title={label} reason={reason} onSetup={() => setTarget(setup)} />
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={`Dismiss ${label} setup`}
                disabled={dismiss.isPending && dismiss.variables?.provider === provider.slug}
                onClick={() => dismiss.mutate({ provider: provider.slug, deferred: false })}>
                <X className="size-4" />
              </Button>
            </div>
          )
        })}
      </div>
      {target && <ChannelSetupDialog target={target} integrations={integrations.data} agentSlug={agentSlug}
        onClose={() => {
          setTarget(null)
          void refresh()
        }} />}
    </HomeGlassPanel>
  )
}
