import { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { useAgent } from '@renderer/hooks/use-agents'
import { agentIntegrationKeys, useAuthorizeAgentIntegration, useUpdateProvisionedApp } from '@renderer/hooks/use-agent-integrations'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { IntegrationSetupFeedback, IntegrationSetupField } from './integration-setup-layout'
import { agentAppIconBase64 } from './slack-app-identity'

/** Starts the install of an installation's provisioned app in a login window; resolves once it is open. */
export function useInstallProvisionedApp(integration: Pick<PublicAgentIntegration, 'id' | 'agentSlug'> | null) {
  const authorize = useAuthorizeAgentIntegration()
  const login = useLoginWindow()
  const install = async () => {
    if (!integration) return
    await login.open(async () => (await authorize.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, config: {} })).url)
  }
  return { install, waiting: login.waiting, busy: authorize.isPending, close: login.close }
}

/**
 * The app a team directory created for this installation, whatever the
 * provider: finish its install, rename it (name and handle), give it the
 * agent's avatar as its icon.
 */
export function ProvisionedAppCard({ integration }: { integration: PublicAgentIntegration }) {
  const app = integration.provisionedApp
  const { data: agent } = useAgent(integration.agentSlug)
  const update = useUpdateProvisionedApp()
  const queryClient = useQueryClient()
  const { install, waiting, busy, close } = useInstallProvisionedApp(integration)
  const [name, setName] = useState(app?.name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => setName(app?.name ?? ''), [app?.name])
  // The install finished in the other window.
  useEffect(() => { if (app?.installed) close() }, [app?.installed, close])
  if (!app) return null

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null); setDone(null)
    try {
      await action()
      setDone(success)
      void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(integration.agentSlug) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update the app')
    }
  }
  const rename = () => run(() => update.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, name: name.trim() }), 'Renamed')
  const setIcon = () => run(async () => {
    if (!agent?.avatar) throw new Error('This agent has no avatar')
    await update.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, icon: await agentAppIconBase64(agent) })
  }, 'Icon updated')

  return <DetailCard label="App">
    <div className="space-y-3 text-sm" data-testid="provisioned-app-card">
      {!app.installed ? <>
        <p>This agent’s app is created. Install it to your workspace to connect.</p>
        <Button size="sm" disabled={busy} onClick={() => void install().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not start the install'))} data-testid="provisioned-app-finish-install">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Finish install
        </Button>
        {waiting && <IntegrationSetupFeedback state="pending">Approve the install in the window that opened. This page updates when it’s done.</IntegrationSetupFeedback>}
      </> : <>
        <IntegrationSetupField id={`app-name-${integration.id}`} label="App name and handle" value={name} maxLength={35}
          onChange={(event) => { setName(event.target.value); setDone(null) }} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={update.isPending || !name.trim() || name.trim() === app.name} onClick={() => void rename()} data-testid="provisioned-app-rename">
            Rename
          </Button>
          {agent?.avatar && (
            <Button size="sm" variant="outline" className="gap-1.5" disabled={update.isPending} onClick={() => void setIcon()} data-testid="provisioned-app-icon">
              <AgentAvatar agent={agent} size={14} />{app.iconSet ? 'Update icon' : 'Set icon'}
            </Button>
          )}
          {update.isPending && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
        </div>
        {!app.iconSet && agent?.avatar && <p className="text-xs text-muted-foreground">The app doesn’t show this agent’s avatar yet.</p>}
      </>}
      {app.settingsUrl && (
        <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={app.settingsUrl} target="_blank" rel="noreferrer">
          App settings<ExternalLink className="h-3 w-3" />
        </a>
      )}
      {done && <IntegrationSetupFeedback state="success">{done}</IntegrationSetupFeedback>}
      {error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    </div>
  </DetailCard>
}
