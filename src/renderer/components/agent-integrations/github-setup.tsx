import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentIntegration, useAgentIntegrationSetup, useAuthorizeAgentIntegration, useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import { Button } from '@renderer/components/ui/button'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { isPublicGitHubIntegration } from '@shared/lib/task-manager-integrations/github/public'
import type { IntegrationSetupProps } from './setup-types'
import { IntegrationSetupLayout, IntegrationSetupField, IntegrationSetupFeedback } from './integration-setup-layout'

export function GitHubSetupForm({ agentSlug, onClose, initial }: IntegrationSetupProps) {
  const { data: agent } = useAgent(agentSlug)
  const setup = useAgentIntegrationSetup(agentSlug, 'github')
  const [name, setName] = useState<string | null>(initial?.name?.slice(0, 34) ?? null)
  const [organization, setOrganization] = useState(initial?.organization ?? '')
  const [id, setId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useCreateAgentIntegration()
  const authorize = useAuthorizeAgentIntegration()
  const login = useLoginWindow()
  const closeLogin = login.close
  const { data: integration, error: refreshError } = useAgentIntegration(id)
  const completed = useRef(false)
  const displayName = (name ?? agent?.name ?? agentSlug).slice(0, 34).trim()
  useEffect(() => {
    if (!integration?.hasCredentials || completed.current) return
    completed.current = true; closeLogin(); onClose()
  }, [integration?.hasCredentials, closeLogin, onClose])
  const connect = async () => {
    setError(null)
    try {
      await login.open(async () => {
        let integrationId = id
        if (!integrationId) {
          const row = await create.mutateAsync({ agentSlug, provider: 'github', name: displayName, config: organization.trim() ? { organization: organization.trim() } : {} })
          integrationId = row.id; setId(row.id)
        }
        return (await authorize.mutateAsync({ id: integrationId, agentSlug, config: {} })).url
      })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect GitHub') }
  }
  const busy = create.isPending || authorize.isPending
  return <IntegrationSetupLayout provider="github" label="GitHub" iconClassName="dark:invert"
    instructions={<>
      <ol className="list-decimal list-outside ml-5 space-y-2.5 text-sm font-normal text-foreground">
        <li>Name this agent’s GitHub App. To use organization repositories, enter that organization’s GitHub name.</li>
        <li>Continue to GitHub and create the preconfigured app. You own its identity; no keys need to be copied.</li>
        <li>Install the app and choose the repositories it can access. Return here when GitHub confirms the connection.</li>
      </ol>
      <p className="text-xs text-muted-foreground">Mention the app’s name in an issue or pull request comment to start work. Repository writers can send follow-ups in the same conversation. Each agent gets its own bot identity.</p>
    </>}
    feedback={<>
      {(error || setup.error || refreshError || integration?.healthMessage) && <IntegrationSetupFeedback state="error">{error ?? setup.error?.message ?? refreshError?.message ?? integration?.healthMessage}</IntegrationSetupFeedback>}
      {login.waiting && !integration?.reconnectRequired && <IntegrationSetupFeedback state="pending">Finish creating and installing the app in GitHub. This window updates automatically.</IntegrationSetupFeedback>}
    </>}
    actions={<Button size="sm" disabled={busy || !displayName || !setup.data} onClick={() => void connect()}>
      {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{id ? 'Continue setup' : 'Connect GitHub'}
    </Button>}
  >
    <IntegrationSetupField id="github-integration-name" label="Integration name" value={name ?? (agent?.name ?? agentSlug).slice(0, 34)} onChange={event => setName(event.target.value)} maxLength={34} disabled={busy || !!id} />
    <IntegrationSetupField id="github-organization" label="GitHub organization (optional)" placeholder="Leave empty for your personal account" value={organization} onChange={event => setOrganization(event.target.value)} disabled={busy || !!id} />
  </IntegrationSetupLayout>
}

export function GitHubConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const authorize = useAuthorizeAgentIntegration()
  const login = useLoginWindow()
  const closeLogin = login.close
  const [error, setError] = useState<string | null>(null)
  const pending = (integration.authorizationPendingUntil ?? 0) > Date.now()
  useEffect(() => { if (integration.hasCredentials && !pending) closeLogin() }, [integration.hasCredentials, pending, closeLogin])
  if (!isPublicGitHubIntegration(integration)) return null
  const connect = async () => {
    setError(null)
    try { await login.open(async () => (await authorize.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, config: {} })).url) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect GitHub') }
  }
  return <DetailCard label="GitHub Account">
    <div className="space-y-3 text-sm">
      {integration.settings.botLogin && <p>{integration.settings.botLogin}{integration.settings.account ? ` · ${integration.settings.account}` : ''}</p>}
      {integration.settings.appUrl && <a className="text-primary underline" href={integration.settings.appUrl} target="_blank" rel="noreferrer">View GitHub App</a>}
      <p className="text-xs text-muted-foreground">The app receives issue and pull request events through webhooks. Manage its repository access in GitHub.</p>
      <Button size="sm" variant="outline" disabled={authorize.isPending} onClick={() => void connect()}>{integration.hasCredentials ? 'Reconnect GitHub' : 'Continue setup'}</Button>
      {pending && <IntegrationSetupFeedback state="pending">Finish installation in GitHub.</IntegrationSetupFeedback>}
      {(error || integration.healthMessage) && <IntegrationSetupFeedback state="error">{error ?? integration.healthMessage}</IntegrationSetupFeedback>}
    </div>
  </DetailCard>
}
