import { useId, useState } from 'react'
import { ArrowRight, Check, ChevronRight, Clock3, Plus } from 'lucide-react'
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

/** Two columns from `sm`, one on phones. */
const CHANNEL_GRID_CLASS = 'grid grid-cols-1 gap-2 sm:grid-cols-2'
/** A channel tile: the add-ons cards' border and fill, one per channel. */
const CHANNEL_TILE_CLASS = 'flex items-start gap-2.5 rounded-card border bg-card/50 py-3 pl-3 pr-2.5'

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
    // Saved for later is a reminder already set, not something left to do
    // now: it reads as a quiet state (the clock "Set this up later" showed),
    // and still opens setup if clicked. Only a connection actually begun and
    // left halfway asks to be finished.
    const later = !configured && !!saved
    const action = configured ? 'Configured' : later ? 'Saved for later' : setupTarget.integrationId ? 'Finish setup' : 'Set up'
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
    // A tile, laid out in a line so it stays short: the service's icon, its
    // name over what it does (wrapping, never cut), and its action. The
    // action is an icon whose words are in its
    // tooltip and accessible name: + to set up, a clock once saved for
    // later, an arrow for a connection left halfway, a check when done.
    const icon = configured ? <Check aria-hidden /> : later ? <Clock3 aria-hidden /> : setupTarget.integrationId ? <ArrowRight aria-hidden /> : <Plus aria-hidden />
    return <div key={provider.slug} className={CHANNEL_TILE_CLASS}>
      {/* The mark on a chip, as Agent Home's integrations panel draws it
          (home-agent-integrations.tsx): hairline border, light in both
          themes so black marks read, which is also why the mark keeps its
          own colours here (no dark-mode invert) and a plain glyph (Inbox,
          Meetings) stays dark on it. */}
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-sm dark:bg-zinc-200 dark:text-zinc-900" aria-hidden>
        <ServiceIcon slug={provider.slug} fallback="mcp" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{provider.description}</p>
      </div>
      <ChannelAction action={action} title={title} reason={reason} onSetup={() => setTarget(setupTarget)} iconOnly icon={icon}
        quiet={configured || later}
        {...later && {
          label: `Set up ${title}, saved for later`,
          hint: 'Saved for later as a reminder. Click to set it up now.',
        }} />
    </div>
  }

  return <>
    {/* One grid for both: More's tiles carry on after the featured two. */}
    <div className={CHANNEL_GRID_CLASS}>
      {featured.map(channelRow)}
      {expanded && moreChannels.map(channelRow)}
    </div>
    {/* What More controls, for aria-controls; its tiles join the grid above. */}
    <span id={moreId} hidden />
    {/* Under the card, on its left edge, like Agent Home's Show more but a
        step stronger than the section headers; its chevron turns down once
        open (aria-expanded says so to a screen reader). */}
    <button type="button" aria-expanded={expanded} aria-controls={moreId} aria-label="More channels"
      className="mt-2 flex min-h-8 items-center gap-1 rounded-control text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setExpanded(open => !open)}>
      More
      <ChevronRight aria-hidden className={`size-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </button>
    {target && <ChannelSetupDialog agentSlug={agentSlug} target={target} integrations={integrations.data} onClose={() => {
      setTarget(null)
      void integrations.refetch()
    }} />}
  </>
}
