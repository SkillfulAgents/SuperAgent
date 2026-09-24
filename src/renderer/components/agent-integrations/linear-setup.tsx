import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useAgent } from '@renderer/hooks/use-agents'
import { agentIntegrationKeys, useAgentIntegration, useAgentIntegrationSetup, useAuthorizeAgentIntegration, useCreateAgentIntegration, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { defaultTransport, type IntegrationTransport } from '@shared/lib/agent-integrations/transport'
import { isPublicLinearIntegration, type PublicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/public'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import { ToggleRow } from './integration-settings-controls'
import { IntegrationSetupLayout, IntegrationSetupField, IntegrationSetupFeedback } from './integration-setup-layout'

function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href} target="_blank" rel="noreferrer" onClick={event => {
    if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(href) }
  }}>{children}<ExternalLink className="h-3.5 w-3.5" /></a>
}

function TransportOption({ checked, onSelect, label, hint }: { checked: boolean; onSelect: () => void; label: string; hint: string }) {
  return <label className="flex items-start gap-2 text-sm cursor-pointer">
    <input type="radio" name="linear-transport" className="mt-1" checked={checked} onChange={onSelect} />
    <span>{label}<span className="block text-xs text-muted-foreground">{hint}</span></span>
  </label>
}

/** OAuth changes the connection step, while the setup frame remains shared. */
export function LinearSetupForm({ agentSlug, onClose }: { agentSlug: string; onClose: () => void }) {
  const { data: agent } = useAgent(agentSlug)
  const [name, setName] = useState<string | null>(null)
  const displayName = (name ?? agent?.name ?? agentSlug).trim()
  const setup = useAgentIntegrationSetup(agentSlug, 'linear', displayName || undefined)
  const create = useCreateAgentIntegration()
  const authorization = useAuthorizeAgentIntegration()
  const { open: openLogin, close: closeLogin } = useLoginWindow()
  const [integrationId, setIntegrationId] = useState<string | null>(null)
  const { data: integration, error: refreshError } = useAgentIntegration(integrationId)
  const linear = integration && isPublicLinearIntegration(integration) ? integration.linear : undefined
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [credentialsSaved, setCredentialsSaved] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const connecting = useRef(false)
  const completed = useRef(false)
  const queryClient = useQueryClient()
  const pending = linear?.authorizationState === 'pending' && credentialsSaved
  // Webhooks through the relay when the host has one: events that arrive while
  // it's offline are still delivered. Fixed once the account exists.
  const { data: relay } = useWebhookRelay()
  const transports = setup.data?.transports ?? ['direct']
  const relayOffered = transports.includes('relay') && !!relay?.available
  const [chosenTransport, setChosenTransport] = useState<IntegrationTransport | null>(null)
  const transport: IntegrationTransport = linear?.transport ?? (relayOffered ? chosenTransport ?? defaultTransport(transports, true) : 'direct')
  const viaRelay = transport === 'relay'
  const creationUrl = viaRelay ? linear?.setup.creationUrl : setup.data?.creationUrl

  useEffect(() => {
    if (linear?.authorizationState === 'reconnect_needed') closeLogin()
    if (!linear?.authorized || !integrationId || completed.current) return
    completed.current = true
    void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
    closeLogin()
    onClose()
  }, [linear?.authorizationState, linear?.authorized, integrationId, closeLogin, onClose, agentSlug, queryClient])

  // The app's webhook URL must exist before the app, so relay setup creates the account first.
  const prepareWebhook = async () => {
    setBusy(true); setError(null)
    try {
      const row = await create.mutateAsync({ agentSlug, provider: 'linear', name: displayName, config: { transport: 'relay' } })
      setIntegrationId(row.id)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create the webhook URL') }
    finally { setBusy(false) }
  }

  const connect = async () => {
    if (connecting.current) return
    connecting.current = true
    setBusy(true); setError(null); setAuthUrl(null)
    try {
      await openLogin(async () => {
        // Keep the created ID on failure so retries authorize the same account.
        let id = integrationId
        if (!id) {
          const row = await create.mutateAsync({ agentSlug, provider: 'linear', name: displayName, config: {} })
          id = row.id
          setIntegrationId(id)
        }
        const result = await authorization.mutateAsync({ id, agentSlug, config: credentialsSaved ? {} : { clientId, clientSecret, ...(viaRelay ? { webhookSecret } : {}) } })
        setClientSecret(''); setWebhookSecret(''); setCredentialsSaved(true); setAuthUrl(result.url)
        return result.url
      })
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not connect integration') }
    finally { connecting.current = false; setBusy(false) }
  }

  return <IntegrationSetupLayout
    provider="linear" label="Linear" iconClassName="dark:invert"
    instructions={<>
      <ol className="list-decimal list-outside ml-5 space-y-2.5 text-sm font-normal text-foreground">
        <li>Choose a name for this agent, then create its own private app in Linear.
          <div className="mt-3">
            {viaRelay && !integrationId
              ? <Button size="sm" variant="outline" disabled={busy || !displayName || !setup.data} onClick={() => void prepareWebhook()}>Get webhook URL</Button>
              : creationUrl ? <ExternalButton href={creationUrl}>Create app in Linear</ExternalButton> : <span className="text-xs text-muted-foreground">Loading app setup…</span>}
          </div>
        </li>
        {viaRelay
          ? <li>Add an avatar and keep the app private. The callback and this agent’s webhook URL are prefilled: keep webhooks on, with inbox notifications, comments and issues.</li>
          : <li>Add an avatar, keep the app private, and leave webhooks off. The callback URL is prefilled.</li>}
        <li>{viaRelay ? 'Copy the app’s Client ID, Client secret and webhook Signing secret into this form.' : 'Copy the app’s Client ID and Client secret into this form.'}</li>
        <li>Click Connect, then authorize the agent in Linear. Choose the workspace and teams it can access.</li>
      </ol>
      <p className="text-xs text-muted-foreground">This agent will have its own identity. Mention it in comments or delegate issues to it to start work.</p>
      {setup.data?.redirectUri && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Callback URL</summary><p className="mt-2 break-all select-all">{setup.data.redirectUri}</p></details>}
    </>}
    feedback={<>
      {setup.error && <IntegrationSetupFeedback state="error">{setup.error.message} <button className="underline" onClick={() => void setup.refetch()}>Try again</button></IntegrationSetupFeedback>}
      {(error || linear?.authorizationMessage || refreshError) && <IntegrationSetupFeedback state="error">{error ?? linear?.authorizationMessage ?? 'Could not check authorization. Reopen this integration to continue.'}</IntegrationSetupFeedback>}
      {pending && <IntegrationSetupFeedback state="pending">
        <p>Waiting for authorization in Linear. This window will update when you’re connected.</p>
        {authUrl && <a href={authUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block underline" onClick={event => {
          if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(authUrl) }
        }}>Open Linear again</a>}
      </IntegrationSetupFeedback>}
    </>}
    actions={<>
      {credentialsSaved && <Button size="sm" variant="ghost" className="mr-auto" disabled={busy} onClick={() => {
        closeLogin(); setCredentialsSaved(false); setAuthUrl(null); setError(null)
      }}>Edit credentials</Button>}
      <Button size="sm" disabled={busy || !displayName || !setup.data || (viaRelay && !integrationId) || (!credentialsSaved && (!clientId.trim() || !clientSecret.trim() || (viaRelay && !webhookSecret.trim())))} onClick={() => void connect()}>
        {busy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Connecting...</> : pending ? 'Start again' : 'Connect'}
      </Button>
    </>}
  >
    {relayOffered && !integrationId && <fieldset className="space-y-1.5" disabled={busy}>
      <legend className="text-xs">Receive Linear events</legend>
      <TransportOption checked={viaRelay} onSelect={() => setChosenTransport('relay')} label="Through webhooks" hint="Recommended. Events that happen while this agent is offline are delivered when it’s back." />
      <TransportOption checked={!viaRelay} onSelect={() => setChosenTransport('direct')} label="Over a live connection" hint="Events that happen while it’s disconnected are missed." />
    </fieldset>}
    <IntegrationSetupField id="setup-integration-name" label="Integration name" value={name ?? agent?.name ?? agentSlug} onChange={event => setName(event.target.value)} maxLength={80} disabled={busy || !!integrationId} />
    <IntegrationSetupField id="linear-client-id" label="Client ID" value={clientId} onChange={event => setClientId(event.target.value)} autoComplete="off" disabled={busy || credentialsSaved} />
    <IntegrationSetupField id="linear-client-secret" label="Client secret" type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} autoComplete="new-password" placeholder={credentialsSaved ? 'Saved securely' : undefined} disabled={busy || credentialsSaved} />
    {viaRelay && <IntegrationSetupField id="linear-webhook-secret" label="Webhook signing secret" type="password" value={webhookSecret} onChange={event => setWebhookSecret(event.target.value)} autoComplete="new-password" placeholder={credentialsSaved ? 'Saved securely' : undefined} disabled={busy || credentialsSaved} />}
  </IntegrationSetupLayout>
}

/** Only credentials differ by provider; lifecycle, settings and history stay shared. */
export function LinearConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [editCredentials, setEditCredentials] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const authorization = useAuthorizeAgentIntegration()
  const { open: openLogin, close: closeLogin } = useLoginWindow()
  const connected = isPublicLinearIntegration(integration) && integration.linear.authorized
  useEffect(() => { if (connected) closeLogin() }, [connected, closeLogin])
  if (!isPublicLinearIntegration(integration)) return null
  const linear = integration.linear
  const needsCredentials = !linear.canReconnect || editCredentials
  // A relay installation can't authorize without it (e.g. setup stopped after the webhook URL).
  const needsWebhookSecret = needsCredentials && linear.transport === 'relay' && !linear.webhook?.secretSaved
  const pending = linear.authorizationState === 'pending'
  const authorize = async (useSaved = false) => {
    setBusy(true); setError(null); setAuthUrl(null)
    try {
      await openLogin(async () => {
        const result = await authorization.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, config: useSaved ? {} : { clientId, clientSecret, ...(needsWebhookSecret ? { webhookSecret } : {}) } })
        setClientSecret(''); setWebhookSecret(''); setEditCredentials(false); setAuthUrl(result.url)
        return result.url
      })
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not authorize integration') }
    finally { setBusy(false) }
  }
  return <DetailCard label="Linear Account">
    <div className="space-y-4">
      {linear.identity && <div><p className="text-sm font-medium">{linear.identity.appName}</p><p className="text-xs text-muted-foreground">{linear.identity.workspaceName}</p></div>}
      {linear.authorizationMessage && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">{linear.authorizationMessage}</p>}
      {needsCredentials && <>
        <div className="space-y-2"><p className="text-sm font-medium">1. Create your agent’s app</p>
          <p className="text-xs text-muted-foreground">Use the prefilled form, add an avatar, keep the app private, and {linear.transport === 'relay' ? 'keep webhooks on' : 'leave webhooks off'}. To reconnect, use the existing app.</p>
          <ExternalButton href={linear.setup.creationUrl}>Create app in Linear</ExternalButton>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Callback URL</summary><p className="mt-2 break-all">{linear.setup.redirectUri}</p></details>
        </div>
        <div className="space-y-3"><p className="text-sm font-medium">2. Copy the app credentials</p>
          <div className="space-y-1"><Label htmlFor="linear-client-id">Client ID</Label><Input id="linear-client-id" autoComplete="off" value={clientId} onChange={event => { setClientId(event.target.value); setAuthUrl(null) }} /></div>
          <div className="space-y-1"><Label htmlFor="linear-client-secret">Client secret</Label><Input id="linear-client-secret" type="password" autoComplete="new-password" value={clientSecret} onChange={event => { setClientSecret(event.target.value); setAuthUrl(null) }} /></div>
          {needsWebhookSecret && <div className="space-y-1"><Label htmlFor="linear-reconnect-webhook-secret">Webhook signing secret</Label><Input id="linear-reconnect-webhook-secret" type="password" autoComplete="new-password" value={webhookSecret} onChange={event => { setWebhookSecret(event.target.value); setAuthUrl(null) }} /></div>}
        </div>
      </>}
      <div className="space-y-2">
        {needsCredentials && <><p className="text-sm font-medium">3. Authorize this agent</p>
          <p className="text-xs text-muted-foreground">Choose the workspace and teams this agent can access. Allow it to read, edit, receive mentions and receive delegated issues.</p></>}
        {pending && !editCredentials && <>
          {authUrl && <ExternalButton href={authUrl}>Authorize in Linear</ExternalButton>}
          <p className="text-xs text-muted-foreground">Waiting for authorization. This page updates automatically.</p>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={needsCredentials ? 'default' : 'outline'} disabled={busy || (needsCredentials && (!clientId.trim() || !clientSecret.trim() || (needsWebhookSecret && !webhookSecret.trim())))} onClick={() => void authorize(!needsCredentials)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{needsCredentials ? 'Continue to authorization' : pending ? 'Start again' : 'Reconnect account'}
          </Button>
          {linear.canReconnect && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditCredentials(!editCredentials); setAuthUrl(null); setError(null) }}>{editCredentials ? 'Cancel' : 'Edit app credentials'}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}

export function LinearIntegrationSettings({ integration }: { integration: PublicAgentIntegration }) {
  const update = useUpdateAgentIntegration()
  if (!isPublicLinearIntegration(integration)) return null
  return <>
    <DetailCard label="Integration Settings"><ToggleRow
      label="Run on status changes" helperText="Start work when an involved issue changes status."
      checked={integration.settings.runOnStatusChange} disabled={update.isPending}
      onCheckedChange={runOnStatusChange => update.mutate({ id: integration.id, settings: { runOnStatusChange } })}
    /></DetailCard>
    <LinearDeliverySettings integration={integration} />
  </>
}

/** What Linear's app settings call each webhook resource type. */
const LINEAR_EVENT_LABELS: Record<string, string> = { AppUserNotification: 'Inbox notifications', Comment: 'Comments', Issue: 'Issues' }

/** Which transport brings Linear's events in. Switching is explicit: the Linear app's webhooks change with it. */
function LinearDeliverySettings({ integration }: { integration: PublicLinearIntegration }) {
  const update = useUpdateAgentIntegration()
  const { data: relay } = useWebhookRelay()
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { transport, webhook } = integration.linear
  const save = (settings: Record<string, unknown>) => {
    setError(null)
    update.mutate({ id: integration.id, settings }, {
      onSuccess: () => setSecret(''),
      onError: failure => setError(failure.message),
    })
  }
  return <DetailCard label="Event Delivery">
    <div className="space-y-3">
      <p className="text-sm">{transport === 'relay'
        ? 'Through webhooks. Events that happen while this agent is offline are delivered when it’s back.'
        : 'Over a live connection. Events that happen while it’s disconnected are missed.'}</p>
      {transport === 'relay' && relay && !relay.available && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">The webhook relay is unavailable. Linear’s events wait until it’s back.</p>}
      {transport === 'relay' && webhook && <>
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">In this agent’s Linear app, turn webhooks on with this URL and these events: {webhook.resourceTypes.map(type => LINEAR_EVENT_LABELS[type] ?? type).join(', ')}.</p>
          <p className="break-all select-all font-mono" data-testid="linear-webhook-url">{webhook.url}</p>
        </div>
        {!webhook.secretSaved && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">Paste the app’s webhook signing secret to start receiving events.</p>}
        {webhook.secretRejected && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">Linear’s deliveries don’t match the saved signing secret. Paste it again from the app’s settings; events wait until then.</p>}
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="linear-webhook-secret-update">Webhook signing secret</Label>
            <Input id="linear-webhook-secret-update" type="password" autoComplete="new-password" value={secret} placeholder={webhook.secretSaved ? 'Saved securely' : undefined} onChange={event => setSecret(event.target.value)} />
          </div>
          <Button size="sm" disabled={update.isPending || !secret.trim()} onClick={() => save({ webhookSecret: secret.trim() })}>Save</Button>
        </div>
      </>}
      {transport === 'direct' && relay?.available && <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => save({ transport: 'relay' })}>Switch to webhooks</Button>}
      {transport === 'relay' && <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => save({ transport: 'direct' })}>Switch to a live connection</Button>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}
