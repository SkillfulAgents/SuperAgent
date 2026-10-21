import { apiFetch } from '@renderer/lib/api'
import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useUser } from '@renderer/context/user-context'
import { integrationSetupProviders } from '@renderer/components/agent-integrations/setup-providers'
import { AgentIntegrationSetupDialog } from '@renderer/components/agent-integrations/agent-integration-setup-dialog'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'
import type { OwnerSetupPrefill } from '@shared/lib/agent-integrations/owner-setup-schema'
import { cn } from '@shared/lib/utils/cn'
import { DeclineButton } from '../requests/decline-button'
import { RequestItemShell } from '../requests/request-item-shell'
import { RequestItemActions } from '../requests/request-item-actions'
import { useRequestHandler } from '../requests/use-request-handler'

interface IntegrationSetupRequestItemProps {
  toolUseId: string
  provider: string
  reason?: string
  prefill?: OwnerSetupPrefill
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

/**
 * The agent asked its owner for an integration only they may set up. The
 * owner sets it up in the provider's usual form; the host answers the agent
 * when an integration of that provider connects, wherever it was set up, and
 * that settles this card.
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
  const { canAdminAgent } = useUser()
  const { status, error, submit } = useRequestHandler(onComplete)
  const [setupOpen, setSetupOpen] = useState(false)
  const setupProvider = integrationSetupProviders.find((candidate) => candidate.slug === provider) ?? null
  const label = setupProvider?.label ?? formatProviderName(provider)
  const canSetUp = !!setupProvider && canAdminAgent(agentSlug)

  const decline = (declineReason?: string) => submit(async (signal) => {
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
  }, 'declined')

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
      completed={status === 'declined' ? { icon, label: `${label} setup`, statusLabel: 'Declined', isSuccess: false } : null}
      readOnly={readOnly ? {} : false}
      error={error}
      data-testid="integration-setup-request"
      data-status={status === 'declined' ? status : undefined}
    >
      <p className="pt-3 text-xs text-muted-foreground">
        {canSetUp
          ? `The agent wants its own ${label} account. It continues once the integration is connected.`
          : `Only the agent's owner can set up ${label}. The agent continues once they do.`}
      </p>

      <RequestItemActions>
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
      </RequestItemActions>

      <AgentIntegrationSetupDialog
        agentSlug={agentSlug}
        provider={setupOpen ? setupProvider : null}
        initial={prefill}
        // Stay in the session: the card settles when the integration connects.
        onCreated={() => {}}
        onOpenChange={(open) => { if (!open) setSetupOpen(false) }}
      />
    </RequestItemShell>
  )
}
