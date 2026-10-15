import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgentIntegrationStatus, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { publicSlackDelivery, type PublicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { slackManifestSettings } from '@shared/lib/chat-integrations/slack-manifest'

const SLACK_APPS_URL = 'https://api.slack.com/apps'

export function CopyTextButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false)
  return <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" data-testid={testId} onClick={async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }}>
    {copied ? <><Check className="h-3 w-3 mr-1" /> Copied</> : <><Copy className="h-3 w-3 mr-1" /> {label}</>}
  </Button>
}

export function SlackAppsLink({ children = 'api.slack.com/apps' }: { children?: ReactNode }) {
  return <a href={SLACK_APPS_URL} target="_blank" rel="noopener noreferrer" className="underline text-primary hover:text-primary/80" onClick={event => {
    if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(SLACK_APPS_URL) }
  }}>{children}</a>
}

function WebhookUrl({ url }: { url: string }) {
  return <div className="space-y-1.5">
    <p className="break-all select-all rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="slack-webhook-url">{url}</p>
    <CopyTextButton text={url} label="Copy URL" />
  </div>
}

function SecretField({ id, label, value, saved, onChange }: { id: string; label: string; value: string; saved?: boolean; onChange: (value: string) => void }) {
  return <div className="space-y-1">
    <Label htmlFor={id} className="text-xs font-normal">{label}</Label>
    <Input id={id} type="password" autoComplete="new-password" value={value} placeholder={saved ? 'Saved securely' : undefined} onChange={event => onChange(event.target.value)} />
  </div>
}

const steps = 'list-decimal list-outside ml-5 space-y-1.5 text-xs text-muted-foreground'

/**
 * How Slack reaches this agent, and the guide for moving the app between
 * Socket Mode and webhooks. Only the app's owner can switch it, in Slack, so
 * each move is explicit: the agent keeps Socket Mode until Slack's first
 * request to the webhook URL arrives and verifies.
 */
export function SlackDeliveryCard({ integration }: { integration: PublicAgentIntegration }) {
  const slack = publicSlackDelivery(integration)
  const { data: connection } = useAgentIntegrationStatus(integration.id)
  const { data: relay } = useWebhookRelay()
  if (!slack) return null
  const webhook = slack.webhook
  const running = connection?.transport ?? null
  const path = running === 'relay'
    ? 'Through webhooks. Messages sent while this agent is offline are delivered when it’s back.'
    : running === 'direct'
      ? webhook
        ? 'Over Socket Mode, until Slack’s first request to the webhook URL arrives.'
        : 'Over Socket Mode. Messages sent while it’s disconnected are missed.'
      : webhook?.status === 'verified' && relay && !relay.available
        ? 'Not receiving: the webhook relay is unavailable. Slack’s messages wait for it and are delivered when it’s back.'
        : 'Not connected.'
  return <DetailCard label="Event Delivery">
    <div className="space-y-3 text-sm">
      <p data-testid="slack-delivery-path">{path}</p>
      {!webhook && relay?.available && slack.botTokenSaved && <SetUpWebhooks integrationId={integration.id} slack={slack} />}
      {webhook && webhook.status !== 'verified' && slack.botTokenSaved && <SwitchToWebhooks integrationId={integration.id} slack={slack} url={webhook.url} rejected={webhook.status === 'rejected'} />}
      {webhook?.status === 'verified' && <WebhookSettings integrationId={integration.id} slack={slack} url={webhook.url} />}
    </div>
  </DetailCard>
}

function useSave(integrationId: string) {
  const update = useUpdateAgentIntegration()
  const [error, setError] = useState<string | null>(null)
  const save = (change: { settings?: Record<string, unknown>; config?: Record<string, unknown> }, onSaved?: () => void) => {
    setError(null)
    update.mutate({ id: integrationId, ...change }, { onSuccess: () => onSaved?.(), onError: failure => setError(failure.message) })
  }
  return { save, pending: update.isPending, error }
}

function SaveError({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null
}

/** Step one for an app on Socket Mode: the signing secret, which mints the agent's webhook URL. */
function SetUpWebhooks({ integrationId, slack }: { integrationId: string; slack: PublicSlackDelivery }) {
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState('')
  const { save, pending, error } = useSave(integrationId)
  if (!open) {
    return <div className="space-y-2">
      <p className="text-xs text-muted-foreground">With webhooks, Slack sends this agent’s messages to a URL instead, and messages sent while it’s offline are delivered when it’s back.</p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Set up webhooks</Button>
    </div>
  }
  const ready = !!secret.trim() || slack.signingSecretSaved
  return <div className="space-y-3" data-testid="slack-webhook-setup">
    <ol className={steps}>
      <li>Open your app at <SlackAppsLink />. In <strong className="font-medium text-foreground">Basic Information → App Credentials</strong>, copy the <strong className="font-medium text-foreground">Signing Secret</strong>.</li>
      <li>Paste it here and continue. This agent gets a webhook URL to put in the app next.</li>
    </ol>
    <SecretField id="slack-signing-secret-setup" label="Signing secret" value={secret} saved={slack.signingSecretSaved} onChange={setSecret} />
    <div className="flex gap-2">
      <Button size="sm" disabled={pending || !ready} onClick={() => save({ settings: { webhooks: true }, ...(secret.trim() ? { config: { signingSecret: secret.trim() } } : {}) }, () => setSecret(''))}>Continue</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
    </div>
    <SaveError error={error} />
  </div>
}

/**
 * Where the URL goes in the app. Saving the Event Subscriptions URL is what
 * verifies the webhook, before Interactivity has it, so these stay on hand.
 */
function SlackAppSteps({ url }: { url: string }) {
  const settings = JSON.stringify({ settings: slackManifestSettings(url) }, null, 2)
  return <>
    <ol className={steps}>
      <li>Open your app at <SlackAppsLink />. In <strong className="font-medium text-foreground">Socket Mode</strong>, turn off <em>Enable Socket Mode</em>.</li>
      <li>In <strong className="font-medium text-foreground">Event Subscriptions</strong>, paste the URL as the <em>Request URL</em>. Slack checks it and shows <em>Verified</em>. Click <em>Save Changes</em>.</li>
      <li>In <strong className="font-medium text-foreground">Interactivity &amp; Shortcuts</strong>, paste the same URL as the <em>Request URL</em>, then click <em>Save Changes</em>.</li>
    </ol>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Or edit the app manifest</summary>
      <div className="mt-2 space-y-2">
        <p>In <strong className="font-medium text-foreground">App Manifest</strong>, replace the <code>settings</code> section with this, then save. Slack asks you to verify the URL.</p>
        <pre className="max-h-40 overflow-auto rounded-md border bg-background p-2 text-2xs leading-relaxed select-all">{settings}</pre>
        <CopyTextButton text={settings} label="Copy settings" />
      </div>
    </details>
  </>
}

/** Step two: the app's owner points it at the URL. Socket Mode keeps working until Slack's first request arrives. */
function SwitchToWebhooks({ integrationId, slack, url, rejected }: { integrationId: string; slack: PublicSlackDelivery; url: string; rejected: boolean }) {
  return <div className="space-y-3" data-testid="slack-webhook-switch">
    {rejected ? <SecretRejected integrationId={integrationId} /> : <p role="status" className="text-xs text-muted-foreground" data-testid="slack-webhook-waiting">
      Waiting for Slack’s first request to this URL.{slack.appTokenSaved ? ' Socket Mode keeps working until it arrives.' : ' Until it arrives, this agent can’t receive messages.'}
    </p>}
    <p className="text-xs font-medium">Point your Slack app at this agent’s webhook URL:</p>
    <WebhookUrl url={url} />
    <SlackAppSteps url={url} />
    <RemoveWebhooks integrationId={integrationId} slack={slack} />
  </div>
}

function SecretRejected({ integrationId }: { integrationId: string }) {
  const [secret, setSecret] = useState('')
  const { save, pending, error } = useSave(integrationId)
  return <div className="space-y-2" data-testid="slack-webhook-rejected">
    <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
      Slack’s request to this URL doesn’t match the saved signing secret. Copy it again from <strong className="font-medium">Basic Information → App Credentials</strong>.
    </p>
    <div className="flex items-end gap-2">
      <div className="flex-1"><SecretField id="slack-signing-secret-fix" label="Signing secret" value={secret} onChange={setSecret} /></div>
      <Button size="sm" disabled={pending || !secret.trim()} onClick={() => save({ config: { signingSecret: secret.trim() } }, () => setSecret(''))}>Save</Button>
    </div>
    <SaveError error={error} />
  </div>
}

/** On webhooks: the URL for reference, a new signing secret if the app's changes, and the way back. */
function WebhookSettings({ integrationId, slack, url }: { integrationId: string; slack: PublicSlackDelivery; url: string }) {
  const [secret, setSecret] = useState('')
  const { save, pending, error } = useSave(integrationId)
  return <div className="space-y-3" data-testid="slack-webhook-settings">
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Slack reaches this agent at this URL. Answer buttons need it too, as the <em>Request URL</em> in <strong className="font-medium text-foreground">Interactivity &amp; Shortcuts</strong>.</p>
      <WebhookUrl url={url} />
    </div>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Steps in Slack</summary>
      <div className="mt-2 space-y-2"><SlackAppSteps url={url} /></div>
    </details>
    <div className="flex items-end gap-2">
      <div className="flex-1"><SecretField id="slack-signing-secret-update" label="Signing secret" value={secret} saved={slack.signingSecretSaved} onChange={setSecret} /></div>
      <Button size="sm" disabled={pending || !secret.trim()} onClick={() => save({ config: { signingSecret: secret.trim() } }, () => setSecret(''))}>Save</Button>
    </div>
    <SaveError error={error} />
    <RemoveWebhooks integrationId={integrationId} slack={slack} />
  </div>
}

/** Back to Socket Mode, which needs an app-level token. */
function RemoveWebhooks({ integrationId, slack }: { integrationId: string; slack: PublicSlackDelivery }) {
  const [open, setOpen] = useState(false)
  const [appToken, setAppToken] = useState('')
  const { save, pending, error } = useSave(integrationId)
  if (!slack.botTokenSaved) return null
  if (!open) return <Button size="sm" variant="ghost" className="-ml-2" onClick={() => setOpen(true)}>Remove webhooks</Button>
  return <div className="space-y-3 rounded-md border p-3" data-testid="slack-webhook-remove">
    <p className="text-xs font-medium">Move the app back to Socket Mode</p>
    <ol className={steps}>
      <li>In your app at <SlackAppsLink />, open <strong className="font-medium text-foreground">Socket Mode</strong> and turn on <em>Enable Socket Mode</em>.</li>
      {!slack.appTokenSaved && <li>In <strong className="font-medium text-foreground">Basic Information → App-Level Tokens</strong>, generate a token with the <code>connections:write</code> scope and paste it here.</li>}
      <li>Remove webhooks right away: messages Slack sends in between are missed.</li>
    </ol>
    {!slack.appTokenSaved && <SecretField id="slack-app-token" label="App-level token" value={appToken} onChange={setAppToken} />}
    <div className="flex gap-2">
      <Button size="sm" variant="destructive" disabled={pending || (!slack.appTokenSaved && !appToken.trim())}
        onClick={() => save({ settings: { webhooks: false }, ...(appToken.trim() ? { config: { appToken: appToken.trim() } } : {}) }, () => { setAppToken(''); setOpen(false) })}>
        Remove webhooks
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
    </div>
    <SaveError error={error} />
  </div>
}
