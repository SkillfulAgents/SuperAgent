import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { ArrowUpRight, Globe } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useUser } from '@renderer/context/user-context'
import { integrationSetupProviders } from '@renderer/components/agent-integrations/setup-providers'
import { AgentIntegrationSetupDialog } from '@renderer/components/agent-integrations/agent-integration-setup-dialog'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from '../requests/decline-button'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'
import { useRequestHandler } from '../requests/use-request-handler'

interface IntegrationSetupRequestItemProps {
  toolUseId: string
  provider: string
  reason?: string
  prefill?: Record<string, string>
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

/**
 * The agent handed an integration's setup to the user. They finish it in the
 * provider's usual form, opened here with the agent's suggestions; the host
 * answers the agent when an integration of that provider connects, wherever it
 * was set up, and that settles this card.
 */
export function IntegrationSetupRequestItem({
  toolUseId,
  provider,
  reason,
  prefill,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: IntegrationSetupRequestItemProps) {
  const { canAdminAgent, canUseAgent } = useUser()
  const { status, error, submit } = useRequestHandler(onComplete)
  const [setupOpen, setSetupOpen] = useState(false)
  const setupProvider = integrationSetupProviders.find((candidate) => candidate.slug === provider) ?? null
  const label = setupProvider?.label ?? formatProviderName(provider)
  // The same people who may add it from the agent's home page.
  const ownerOnly = setupProvider?.managementAccess === 'owner'
  const canSetUp = !!setupProvider && (ownerOnly ? canAdminAgent(agentSlug) : canUseAgent(agentSlug))

  const settle = (declineReason: string | undefined, outcome: 'declined' | 'fetch-requested') => submit(async (signal) => {
    const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/decline-integration-setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId, declineReason }),
      signal,
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to decline')
    }
  }, outcome)
  const decline = (declineReason?: string) => settle(declineReason, 'declined')
  // The hand-back: the agent's call ends with what to do instead, as the secret card's "fetch it for me" does.
  const doItForMe = () => settle(
    `The user wants you to set up ${label} yourself instead of handing it to them. Follow its steps in list_available_integration_providers: add_agent_integration with the values you suggested, then your browser where the steps need it. If a login page appears, ask the user to log in with request_browser_input. Hand the setup over again only if you cannot finish it, and say why.`,
    'fetch-requested',
  )

  const icon = <ServiceIcon slug={provider} fallback="mcp" className={cn('h-4 w-4', setupProvider?.iconClassName)} />

  return (
    <RequestItemShell
      title={`Set up ${label} for this agent?`}
      subtitle={reason}
      icon={icon}
      theme="blue"
      sessionId={sessionId}
      agentSlug={agentSlug}
      waitingText="Waiting for setup"
      completed={status === 'declined' ? { icon, label: `${label} setup`, statusLabel: 'Declined', isSuccess: false }
        : status === 'fetch-requested' ? { icon: <Globe className="h-4 w-4 shrink-0 text-blue-500" />, label: `${label} setup`, statusLabel: 'Agent setting it up...', isSuccess: true }
          : null}
      readOnly={readOnly ? {} : false}
      error={error}
      data-testid="integration-setup-request"
      data-status={status === 'declined' || status === 'fetch-requested' ? status : undefined}
    >
      <p className="pt-3 text-xs text-muted-foreground">
        {canSetUp
          ? `The agent wants its own ${label} account. It continues once the integration is connected.`
          : setupProvider
            ? `Only the agent's owner can set up ${label}. The agent continues once they do.`
            : `${label} can't be set up from here.`}
      </p>

      <RequestItemActions className="items-center">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={doItForMe}
                disabled={status === 'submitting'}
                variant="outline"
                size="xs"
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                data-testid="integration-setup-do-it-btn"
              >
                <span>Do it for me</span>
                <ArrowUpRight className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[240px]">
              Rather not do this yourself? Your agent can set {label} up for you, using its browser where it needs to.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <DeclineButton
            onDecline={decline}
            disabled={status === 'submitting'}
            showIcon={false}
            size="xs"
            className="border-border text-foreground hover:bg-muted"
            data-testid="integration-setup-decline-btn"
          />
          {canSetUp && (
            <Button
              onClick={() => setSetupOpen(true)}
              disabled={status === 'submitting'}
              size="xs"
              className="min-w-24 bg-blue-600 text-white hover:bg-blue-700"
              data-testid="integration-setup-open-btn"
            >
              Set up {label}
            </Button>
          )}
        </div>
      </RequestItemActions>

      <AgentIntegrationSetupDialog
        agentSlug={agentSlug}
        provider={setupOpen ? setupProvider : null}
        initial={prefill}
        // Stay in the session: the card settles when the integration connects.
        onIntegrationCreated={() => {}}
        onOpenChange={(open) => { if (!open) setSetupOpen(false) }}
      />
    </RequestItemShell>
  )
}
