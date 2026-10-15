import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { DialogTitle } from '@renderer/components/ui/dialog'
import { agentIntegrationKeys, useCreateAgentIntegration, useTestAgentIntegrationCredentials, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { publicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { slackAppCreationUrl } from '@shared/lib/chat-integrations/slack-manifest'
import { ChatIntegrationSetupForm, ChatSetupBehavior, DEFAULT_CHAT_SETUP_BEHAVIOR, slackBehaviorConfig } from './chat-integration-setup-form'
import { IntegrationSetupFeedback, IntegrationSetupField, IntegrationSetupLayout } from './integration-setup-layout'
import type { IntegrationSetupProps } from './setup-types'

const DEFAULT_APP_NAME = 'Gamut Bot'

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href} target="_blank" rel="noreferrer" onClick={event => {
    if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(href) }
  }}>{children}<ExternalLink className="h-3.5 w-3.5" /></a>
}

/**
 * Slack's setup. With the host's webhook relay, the app posts to the agent's
 * webhook URL (recommended): messages sent while the agent is offline wait for
 * it. Otherwise, or by choice, the app uses Socket Mode.
 */
export function SlackSetup(props: IntegrationSetupProps) {
  const { data: relay, isPending } = useWebhookRelay()
  const [webhooks, setWebhooks] = useState(true)
  // Which form depends on the relay; one that can't be read means Socket Mode.
  if (isPending) return <>
    <DialogTitle className="sr-only">Set up integration with Slack</DialogTitle>
    <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>
  </>
  const choice = (disabled = false) => relay?.available && <label className="flex items-start gap-2 text-sm cursor-pointer">
    <input type="checkbox" className="mt-1" checked={webhooks} disabled={disabled} onChange={event => setWebhooks(event.target.checked)} data-testid="slack-webhooks-choice" />
    <span>Receive through webhooks (recommended)<span className="block text-xs text-muted-foreground">Messages sent while this agent is offline are delivered when it’s back. Without them it uses Socket Mode and misses those.</span></span>
  </label>
  return relay?.available && webhooks
    ? <SlackWebhookSetupForm {...props} choice={choice} />
    : <ChatIntegrationSetupForm {...props} provider="slack" leading={choice()} />
}

function appSteps({ created }: { created: boolean }) {
  return [
    created
      ? 'Create the app in Slack. Its manifest is filled in, with this agent’s webhook URL.'
      : 'Name this integration, then create its Slack app. The manifest is filled in, with this agent’s webhook URL.',
    'Pick your workspace and create the app. If Slack lists the request URL as unverified, open App Manifest and click Verify.',
    <>In <strong className="font-medium">Basic Information → App Credentials</strong>, copy the <strong className="font-medium">Signing Secret</strong> into this form.</>,
    <>In <strong className="font-medium">Install App</strong>, install it to your workspace, then copy the <strong className="font-medium">Bot User OAuth Token</strong> (xoxb-…) into this form.</>,
  ]
}

/**
 * The installation comes first, so the app can be created with its webhook
 * URL; it waits, disconnected, for the app's signing secret and bot token.
 */
function SlackWebhookSetupForm({ agentSlug, onClose, choice }: IntegrationSetupProps & { choice: (disabled?: boolean) => ReactNode }) {
  const create = useCreateAgentIntegration()
  const finish = useUpdateAgentIntegration()
  const testCredentials = useTestAgentIntegrationCredentials()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [created, setCreated] = useState<{ id: string; webhookUrl: string } | null>(null)
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [feedback, setFeedback] = useState<{ valid: boolean; info: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const appName = name.trim() || DEFAULT_APP_NAME

  // The URL must exist before the app, so the first click creates the
  // installation, then opens Slack with it filled in. The tab opens inside
  // the click, before the request, so popup blockers allow it.
  const createApp = async () => {
    const tab = prepareOAuthPopup()
    setBusy(true); setFeedback(null)
    try {
      const row = await create.mutateAsync({ agentSlug, provider: 'slack', name: name.trim() || undefined,
        config: { webhooks: true, ...slackBehaviorConfig(behavior) }, showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout })
      const webhookUrl = publicSlackDelivery(row)?.webhook?.url
      if (!webhookUrl) throw new Error('Could not create the webhook URL')
      setCreated({ id: row.id, webhookUrl })
      await tab.navigate(slackAppCreationUrl(appName, webhookUrl))
    } catch (error) {
      tab.close()
      setFeedback({ valid: false, info: error instanceof Error ? error.message : 'Could not create the webhook URL' })
    } finally { setBusy(false) }
  }

  const verify = async () => {
    setFeedback(null)
    try {
      const result = await testCredentials.mutateAsync({ provider: 'slack', config: { botToken: botToken.trim() } })
      setFeedback({ valid: true, info: `Workspace: ${result.team}` })
    } catch (error) {
      setFeedback({ valid: false, info: error instanceof Error ? error.message : 'Invalid bot token' })
    }
  }

  const connect = async () => {
    if (!created) return
    setBusy(true); setFeedback(null)
    try {
      await finish.mutateAsync({ id: created.id, status: 'active', showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout,
        config: { botToken: botToken.trim(), signingSecret: signingSecret.trim(), ...slackBehaviorConfig(behavior) } })
      void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
      onClose()
    } catch (error) {
      setFeedback({ valid: false, info: error instanceof Error ? error.message : 'Could not connect Slack' })
    } finally { setBusy(false) }
  }

  return <IntegrationSetupLayout
    provider="slack" label="Slack"
    instructions={<div className="space-y-3">
      <ol className="list-decimal list-outside ml-5 space-y-2.5 text-sm font-normal text-foreground">
        {appSteps({ created: !!created }).map((step, i) => <li key={i}>{step}
          {i === 0 && <div className="mt-3">
            {created
              ? <ExternalButton href={slackAppCreationUrl(appName, created.webhookUrl)}>Create app in Slack</ExternalButton>
              : <Button size="sm" variant="outline" disabled={busy} onClick={() => void createApp()} data-testid="slack-create-app">Create app in Slack<ExternalLink className="h-3.5 w-3.5" /></Button>}
          </div>}
        </li>)}
        <li>Click Connect.</li>
      </ol>
      {created && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Webhook URL</summary><p className="mt-2 break-all select-all" data-testid="slack-setup-webhook-url">{created.webhookUrl}</p></details>}
    </div>}
    feedback={feedback && <IntegrationSetupFeedback state={feedback.valid ? 'success' : 'error'}>{feedback.info}</IntegrationSetupFeedback>}
    actions={<>
      <Button size="sm" variant="ghost" className="mr-auto" disabled={testCredentials.isPending || !botToken.trim()} onClick={() => void verify()}>
        {testCredentials.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying...</> : 'Verify token'}
      </Button>
      <Button size="sm" disabled={busy || !created || !botToken.trim() || !signingSecret.trim()} onClick={() => void connect()}>
        {busy && created ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</> : 'Connect'}
      </Button>
    </>}
  >
    {choice(!!created)}
    <IntegrationSetupField id="setup-integration-name" label="Integration name" value={name} onChange={event => setName(event.target.value)}
      placeholder="My Slack integration" disabled={busy || !!created} />
    <IntegrationSetupField id="setup-signingSecret" label="Signing Secret" type="password" autoComplete="new-password" value={signingSecret}
      onChange={event => setSigningSecret(event.target.value)} placeholder="From Basic Information" disabled={!created} />
    <IntegrationSetupField id="setup-botToken" label="Bot Token" type="password" autoComplete="new-password" value={botToken}
      onChange={event => setBotToken(event.target.value)} placeholder="xoxb-..." disabled={!created} />
    <ChatSetupBehavior provider="slack" value={behavior} onChange={setBehavior} />
  </IntegrationSetupLayout>
}

/**
 * An installation set up with webhooks whose Slack app isn't connected yet,
 * e.g. setup stopped after the app was created: the rest of its steps.
 */
export function SlackConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const slack = publicSlackDelivery(integration)
  const update = useUpdateAgentIntegration()
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!slack || slack.botTokenSaved || !slack.webhook) return null
  const connect = () => {
    setError(null)
    update.mutate({ id: integration.id, status: 'active', config: { botToken: botToken.trim(), signingSecret: signingSecret.trim() } }, {
      onSuccess: () => { setBotToken(''); setSigningSecret('') },
      onError: failure => setError(failure.message),
    })
  }
  return <DetailCard label="Slack App">
    <div className="space-y-3" data-testid="slack-finish-setup">
      <p className="text-sm">Finish setting up this agent’s Slack app.</p>
      <ol className="list-decimal list-outside ml-5 space-y-1.5 text-xs text-muted-foreground">
        {appSteps({ created: true }).map((step, i) => <li key={i}>{step}</li>)}
      </ol>
      <ExternalButton href={slackAppCreationUrl(integration.name || DEFAULT_APP_NAME, slack.webhook.url)}>Create app in Slack</ExternalButton>
      <IntegrationSetupField id="slack-finish-signing-secret" label="Signing Secret" type="password" autoComplete="new-password" value={signingSecret} onChange={event => setSigningSecret(event.target.value)} />
      <IntegrationSetupField id="slack-finish-bot-token" label="Bot Token" type="password" autoComplete="new-password" value={botToken} onChange={event => setBotToken(event.target.value)} placeholder="xoxb-..." />
      <Button size="sm" disabled={update.isPending || !botToken.trim() || !signingSecret.trim()} onClick={connect}>
        {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Connect
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}
