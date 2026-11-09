import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { agentIntegrationKeys, useAgentIntegration, useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useAgent } from '@renderer/hooks/use-agents'
import { ChatSetupBehavior, DEFAULT_CHAT_SETUP_BEHAVIOR, slackBehaviorConfig } from './chat-integration-setup-form'
import { IntegrationSetupFeedback, IntegrationSetupField, IntegrationSetupLayout } from './integration-setup-layout'
import type { IntegrationSetupProps } from './setup-types'
import { agentAppIconBase64, slackAppIdentity } from './slack-app-identity'
import { useInstallProvisionedApp } from './provisioned-app-card'

/**
 * Slack's setup when a connected team directory can create apps: Gamut
 * creates this agent's app (its name, @handle, colour and avatar), then one
 * click installs it to the workspace. No tokens to copy.
 */
export function SlackProvisionedSetupForm({ agentSlug, onClose, provisioning, onManual }: IntegrationSetupProps & {
  provisioning: { directoryId: string; workspace: string }
  onManual: () => void
}) {
  const { data: agent } = useAgent(agentSlug)
  const create = useCreateAgentIntegration()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { data: integration } = useAgentIntegration(createdId)
  const { install, waiting, busy: installing, close } = useInstallProvisionedApp(integration ?? null)
  const app = slackAppIdentity(agent, name)

  // Installed in the other window: done.
  useEffect(() => {
    if (!integration?.provisionedApp?.installed) return
    close()
    void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
    onClose()
  }, [integration?.provisionedApp?.installed, close, queryClient, agentSlug, onClose])

  const createApp = async () => {
    setError(null)
    try {
      // The avatar as the app's icon; an app without one still works.
      const icon = agent?.avatar ? await agentAppIconBase64(agent).catch(() => undefined) : undefined
      const row = await create.mutateAsync({
        agentSlug, provider: 'slack', name: name.trim() || undefined,
        config: {
          webhooks: true, ...slackBehaviorConfig(behavior),
          provision: {
            directoryId: provisioning.directoryId, name: app.name,
            ...(app.description ? { description: app.description } : {}),
            ...(app.backgroundColor ? { backgroundColor: app.backgroundColor } : {}),
            ...(icon ? { icon } : {}),
          },
        },
        showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout,
      })
      setCreatedId(row.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the app')
    }
  }

  const startInstall = () => {
    setError(null)
    install().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not start the install'))
  }

  const created = !!createdId
  return <IntegrationSetupLayout
    provider="slack" label="Slack"
    instructions={<div className="space-y-3" data-testid="slack-provisioned-setup">
      <ol className="list-decimal list-outside ml-5 space-y-3 text-sm font-normal text-foreground">
        <li>
          <span className={created ? 'text-muted-foreground' : undefined}>Create this agent’s Slack app in {provisioning.workspace}, with its name, @handle and avatar.</span>
          <div className="mt-2">
            {created
              ? <span className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400" data-testid="slack-provisioned-created"><CheckCircle2 className="h-3.5 w-3.5" />App created in {provisioning.workspace}</span>
              : <Button size="sm" disabled={create.isPending || !agent} onClick={() => void createApp()} data-testid="slack-provisioned-create">
                {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Create app
              </Button>}
          </div>
        </li>
        <li>
          <span className={created ? undefined : 'text-muted-foreground'}>Install it to {provisioning.workspace}: one click on Slack’s page.</span>
          <div className="mt-2">
            <Button size="sm" variant={created ? 'default' : 'outline'} disabled={!created || !integration || installing} onClick={startInstall} data-testid="slack-provisioned-install">
              {installing && <Loader2 className="h-4 w-4 animate-spin" />}Install to {provisioning.workspace}
            </Button>
          </div>
        </li>
      </ol>
      {!created && (
        <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={onManual} data-testid="slack-setup-manually">
          Set up manually instead
        </button>
      )}
    </div>}
    feedback={<>
      {waiting && <IntegrationSetupFeedback state="pending">Approve the install in the window that opened. This updates when it’s done.</IntegrationSetupFeedback>}
      {error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    </>}
    actions={<Button size="sm" variant="ghost" onClick={onClose}>{created ? 'Finish later' : 'Cancel'}</Button>}
  >
    <IntegrationSetupField id="setup-integration-name" label="App name" value={name} maxLength={35}
      onChange={(event) => setName(event.target.value)} placeholder={agent?.name || 'My Slack app'} disabled={created || create.isPending} />
    <ChatSetupBehavior provider="slack" value={behavior} onChange={setBehavior} />
  </IntegrationSetupLayout>
}
