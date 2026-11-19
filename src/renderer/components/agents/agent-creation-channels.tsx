import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { CHAT_PROVIDERS } from '@shared/lib/chat-integrations/config-schema'
import { publicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { AgentIntegrationSetupDialog } from '@renderer/components/agent-integrations/agent-integration-setup-dialog'
import { ProvisionedAppCard } from '@renderer/components/agent-integrations/provisioned-app-card'
import { integrationSetupProviders } from '@renderer/components/agent-integrations/setup-providers'
import type { IntegrationSetupProvider } from '@renderer/components/agent-integrations/setup-types'
import { SlackConnectionSettings } from '@renderer/components/agent-integrations/slack-setup'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useAgentIntegrations, useAvailableAgentIntegrationProviders } from '@renderer/hooks/use-agent-integrations'

const featured = integrationSetupProviders.filter(p => p.slug === 'platform-email' || p.slug === 'slack')
const moreChannels = integrationSetupProviders.filter(p => p.slug !== 'slack' && CHAT_PROVIDERS.some(slug => slug === p.slug))

function needsSlackSetup(integration: PublicAgentIntegration) {
  if (integration.provider !== 'slack') return false
  if (integration.provisionedApp) return !integration.provisionedApp.installed
  const slack = publicSlackDelivery(integration)
  return !!slack?.webhook && !slack.botTokenSaved
}

function ChannelAction({ action, title, reason, onSetup }: {
  action: string; title: string; reason?: string; onSetup: () => void
}) {
  const [showReason, setShowReason] = useState(false)
  return <Tooltip open={!!reason && showReason} onOpenChange={setShowReason}>
    <TooltipTrigger asChild>
      <Button type="button" size="sm" variant="outline" aria-label={`${action} ${title}`}
        aria-disabled={!!reason} className="aria-disabled:cursor-help aria-disabled:opacity-50"
        onClick={event => {
          if (reason) {
            event.preventDefault()
            setShowReason(true)
          } else {
            onSetup()
          }
        }}>
        {action}
      </Button>
    </TooltipTrigger>
    {reason && <TooltipContent align="end" className="max-w-72">{reason}</TooltipContent>}
  </Tooltip>
}

export function AgentCreationChannels({ agentSlug }: { agentSlug: string }) {
  const providers = useAvailableAgentIntegrationProviders()
  const integrations = useAgentIntegrations(agentSlug)
  const [expanded, setExpanded] = useState(false)
  const moreId = useId()
  const [setup, setSetup] = useState<IntegrationSetupProvider | null>(null)
  const [resumeId, setResumeId] = useState<string | null>(null)
  const resume = integrations.data?.find(row => row.id === resumeId && needsSlackSetup(row))

  function channelRow(provider: IntegrationSetupProvider) {
    const inbox = provider.slug === 'platform-email'
    const title = inbox ? 'Inbox' : provider.label
    const rows = integrations.data?.filter(row => row.provider === provider.slug)
    const configured = rows?.some(row => !needsSlackSetup(row))
    const pending = rows?.find(needsSlackSetup)
    const action = configured ? 'Configured' : pending ? 'Finish setup' : 'Set up'
    let reason: string | undefined
    if (configured) {
      reason = `${title} is already set up for this agent.`
    } else if (!pending) {
      if (!providers.data || !integrations.data) {
        reason = providers.isError || integrations.isError ? 'Could not load channels.' : 'Checking available channels…'
      } else if (!providers.data.some(p => p.provider === provider.slug)) {
        reason = inbox ? 'Connect your Gamut account to set up Inbox.' : `${title} is unavailable in this workspace.`
      }
    }
    return <div key={provider.slug} className="flex items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground [&_svg]:size-4" aria-hidden>
        <ServiceIcon slug={provider.slug} fallback="mcp" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{inbox ? 'Give this agent its own email address.' : `Talk to this agent in ${title}.`}</p>
      </div>
      <ChannelAction action={action} title={title} reason={reason} onSetup={() => {
        if (pending) setResumeId(pending.id)
        else setSetup(provider)
      }} />
    </div>
  }

  return <>
    {featured.map(channelRow)}
    <button type="button" aria-label="More channels" aria-expanded={expanded} aria-controls={moreId}
      className="flex w-full items-center justify-between gap-3 rounded-b-card px-4 py-3 text-sm font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-expanded:rounded-none"
      onClick={() => setExpanded(open => !open)}>
      More
      <ChevronDown aria-hidden className={`size-4 text-muted-foreground ${expanded ? 'rotate-180' : ''}`} />
    </button>
    <div id={moreId} hidden={!expanded} className="divide-y">{expanded && moreChannels.map(channelRow)}</div>
    <Dialog open={!!resume} onOpenChange={open => { if (!open) setResumeId(null) }}>
      {resume && <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>Finish Slack setup</DialogTitle>
        {resume.provisionedApp ? <ProvisionedAppCard integration={resume} /> : <SlackConnectionSettings integration={resume} />}
      </DialogContent>}
    </Dialog>
    <AgentIntegrationSetupDialog agentSlug={agentSlug} provider={setup} onIntegrationCreated={() => setSetup(null)} onOpenChange={open => { if (!open) setSetup(null) }} />
  </>
}
