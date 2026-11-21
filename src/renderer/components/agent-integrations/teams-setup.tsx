import { useId, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentIntegrationSetup, useCreateAgentIntegration, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { saveBlob } from '@renderer/lib/download'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { teamsIdentitySchema, type TeamsConfig } from '@shared/lib/chat-integrations/config-schema'
import { publicTeamsDelivery } from '@shared/lib/chat-integrations/public'
import { IntegrationSetupFeedback, IntegrationSetupField, IntegrationSetupLayout } from './integration-setup-layout'
import { CopyTextButton } from './slack-delivery-card'
import { teamsAppPackage, type TeamsPackageAgent } from './teams-app-package'
import type { IntegrationSetupProps } from './setup-types'

const appIdSchema = teamsIdentitySchema.shape.appId
const steps = 'ml-5 list-outside list-decimal space-y-2.5 text-sm'
const ENTRA_URL = 'https://entra.microsoft.com/'
const DEV_PORTAL_URL = 'https://dev.teams.microsoft.com/bots'
const TEAMS_URL = 'https://teams.microsoft.com/'
const TEAMS_ADMIN_URL = 'https://admin.teams.microsoft.com/policies/manage-apps'
type DeliveryMode = TeamsConfig['deliveryMode']

function PortalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" onClick={event => {
    if (window.electronAPI) {
      event.preventDefault()
      void window.electronAPI.openExternal(href)
    }
  }}>{children}</a>
}

function Endpoint({ url }: { url: string }) {
  return <div className="space-y-1.5">
    <p className="text-xs font-medium">Messaging endpoint</p>
    <p className="select-all break-all rounded-item border bg-background px-2 py-1.5 font-mono text-xs" data-testid="teams-messaging-endpoint">{url}</p>
    <CopyTextButton text={url} label="Copy endpoint" />
  </div>
}

function PackageDownload({ agent, appId, name, canUpdate }: {
  agent?: TeamsPackageAgent; appId: string; name: string; canUpdate?: boolean
}) {
  const versionId = useId()
  const [version, setVersion] = useState('1.0.0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const download = async () => {
    if (!agent || busy) return
    setError('')
    setBusy(true)
    try {
      const blob = await teamsAppPackage(agent, appId, name, version)
      saveBlob(blob, `${agent.slug}-teams.zip`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the Teams app package')
    } finally { setBusy(false) }
  }
  return <div className="space-y-2">
    {agent && <div className="flex items-center gap-2">
      {agent.avatar && <AgentAvatar agent={agent} size={32} still />}
      <div className="min-w-0"><p className="truncate text-sm font-medium">{name}</p><p className="text-xs text-muted-foreground">Microsoft Teams app package</p></div>
    </div>}
    {canUpdate && <div className="max-w-72 space-y-1">
      <IntegrationSetupField id={versionId} label="Package version" value={version} onChange={event => setVersion(event.target.value)} />
      <p className="text-xs text-muted-foreground">Increase the version to update an installed app’s name or icon.</p>
    </div>}
    <Button type="button" variant="outline" size="sm" disabled={!agent || !appIdSchema.safeParse(appId).success || !name.trim() || busy} onClick={download}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download app package
    </Button>
    {error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
  </div>
}

function InstallInstructions({ mode }: { mode: DeliveryMode }) {
  return <ol className={steps}>
    <li>In <PortalLink href={DEV_PORTAL_URL}>Developer Portal → Tools → Bot management</PortalLink>, select the bot and open <strong>Configure → Delivery method</strong>. {mode === 'socket' ? <>Select <strong>Socket mode</strong> and save.</> : <>Select <strong>HTTPS endpoint</strong>, paste the messaging endpoint, and save.</>}</li>
    <li>Download the app package. In <PortalLink href={TEAMS_URL}>Teams</PortalLink>, choose <strong>Apps → Manage your apps → More options → Upload an app → Upload a custom app</strong>. Select the ZIP, then add the agent to a chat or team.</li>
    <li>If your organization manages uploads, an admin can upload the same ZIP under <strong>Teams apps → Manage apps → Upload new app</strong> in the <PortalLink href={TEAMS_ADMIN_URL}>Teams admin center</PortalLink>.</li>
    <li>Send a personal message, approve its access request in Gamut, then message again. In channels and group chats, @mention the agent on each message, including replies.</li>
    <li>For a private or shared channel, add the app to the host team and then to the channel. Approving the channel in Gamut lets its members, including external members, talk to the agent there. Channel file links require access in Gamut. Use personal chat in the registered tenant for file transfers.</li>
  </ol>
}

export function TeamsSetup({ agentSlug, initial, onClose, onIntegrationCreated }: IntegrationSetupProps) {
  const formId = useId()
  const navigate = useNavigate()
  const { data: agent } = useAgent(agentSlug)
  const setup = useAgentIntegrationSetup(agentSlug, 'teams')
  const create = useCreateAgentIntegration()
  const [saved, setSaved] = useState<PublicAgentIntegration | null>(null)
  const [typedName, setName] = useState(initial?.name)
  const [tenantId, setTenantId] = useState('')
  const [appId, setAppId] = useState('')
  const [clientSecret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<DeliveryMode>('https')
  const name = (typedName ?? agent?.name ?? '').trim()
  const validAppId = appIdSchema.safeParse(appId).success
  const delivery = saved ? publicTeamsDelivery(saved) : undefined
  const httpsUnavailable = setup.data?.teamsRelayAvailable === false && !setup.data.teamsMessagingBaseUrl
  const endpoint = delivery?.messagingEndpoint || (setup.data?.teamsMessagingBaseUrl && validAppId ? `${setup.data.teamsMessagingBaseUrl}/${appId.trim()}` : undefined)
  const finish = () => {
    if (!saved) return
    onClose()
    if (onIntegrationCreated) onIntegrationCreated(saved.id)
    else void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: saved.id } })
  }

  return <IntegrationSetupLayout provider="teams" label="Microsoft Teams"
    instructions={saved ? <InstallInstructions mode={delivery?.deliveryMode ?? mode} /> : <><ol className={steps}>
      <li>Open <PortalLink href={DEV_PORTAL_URL}>Teams Developer Portal → Tools → Bot management</PortalLink>. Choose <strong>New bot</strong>, enter this agent’s name, then copy its <strong>Bot ID</strong> into the application ID field.</li>
      <li>Open the bot’s <strong>Client secrets</strong>, add a client secret, and copy its value here.</li>
      <li>In the <PortalLink href={ENTRA_URL}>Microsoft Entra admin center</PortalLink>, open <strong>Entra ID → Overview</strong> and copy your tenant ID.</li>
      <li>Choose how Teams delivers messages. Save the credentials to configure delivery and install the app.</li>
    </ol>
      {validAppId && <div className="space-y-3 rounded-item border p-3">
        <PackageDownload agent={agent} appId={appId.trim()} name={name} />
        {mode === 'https' && endpoint && <Endpoint url={endpoint} />}
      </div>}
    </>}
    feedback={error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    actions={saved ? <Button size="sm" onClick={finish}>Done</Button> :
      <Button size="sm" type="submit" form={formId} disabled={create.isPending}>
        {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save and continue
      </Button>}
  >
    {saved ? <div className="space-y-4">
      <IntegrationSetupFeedback state="success">Credentials saved for {saved.name || name}.</IntegrationSetupFeedback>
      {(delivery?.deliveryMode ?? mode) === 'https' && (endpoint ? <Endpoint url={endpoint} /> : <p className="text-xs text-muted-foreground">This host needs a public HTTPS endpoint or a connected Teams relay to receive messages.</p>)}
      <PackageDownload agent={agent} name={saved.name || name} appId={delivery?.appId ?? appId.trim()} />
    </div> : <form id={formId} className="space-y-3" onSubmit={async event => {
      event.preventDefault()
      if (create.isPending) return
      setError('')
      if (!teamsIdentitySchema.shape.tenantId.safeParse(tenantId).success || !validAppId) { setError('Enter the directory and application IDs from the app registration as UUIDs.'); return }
      if (!clientSecret.trim() || !name) { setError('Enter an app name and the client secret value.'); return }
      try {
        const row = await create.mutateAsync({ agentSlug, provider: 'teams', name, config: { tenantId: tenantId.trim(), appId: appId.trim(), clientSecret: clientSecret.trim(), deliveryMode: mode } })
        setSecret('')
        setSaved(row)
      } catch (err) { setError(err instanceof Error ? err.message : 'Could not save Teams credentials') }
    }}>
      <fieldset className="space-y-3" disabled={create.isPending}>
        <IntegrationSetupField id="teams-name" label="App name in Teams" value={typedName ?? agent?.name ?? ''} onChange={event => setName(event.target.value)} maxLength={100} required />
        <IntegrationSetupField id="teams-tenant-id" label="Directory (tenant) ID" value={tenantId} onChange={event => setTenantId(event.target.value)} autoComplete="off" spellCheck={false} required />
        <IntegrationSetupField id="teams-app-id" label="Application (client) ID" value={appId} onChange={event => setAppId(event.target.value)} autoComplete="off" spellCheck={false} required />
        <IntegrationSetupField id="teams-client-secret" label="Client secret value" type="password" value={clientSecret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" required />
        <fieldset className="space-y-1.5 text-xs">
          <legend className="mb-1 font-medium">Delivery method</legend>
          <label className="flex items-center gap-2"><input type="radio" name="teams-delivery" checked={mode === 'https'} onChange={() => setMode('https')} /> HTTPS endpoint</label>
          <label className="flex items-center gap-2"><input type="radio" name="teams-delivery" checked={mode === 'socket'} onChange={() => setMode('socket')} /> Socket mode (preview)</label>
          <p className="text-muted-foreground">{mode === 'socket' ? 'For development and testing with a newly created bot. Gamut opens an outbound connection to Teams.' : 'For production, Teams sends messages to a public HTTPS URL.'}</p>
        </fieldset>
        {mode === 'https' && httpsUnavailable && <p className="text-xs text-muted-foreground">Ask your host administrator to configure a public HTTPS URL or Teams relay for this workspace.</p>}
        {mode === 'https' && setup.data?.teamsRelayAvailable && <p className="text-xs text-muted-foreground">Save the credentials to generate this bot’s public messaging endpoint.</p>}
      </fieldset>
    </form>}
  </IntegrationSetupLayout>
}

export function TeamsConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const { data: agent } = useAgent(integration.agentSlug)
  const teams = publicTeamsDelivery(integration)
  const [secret, setSecret] = useState('')
  const update = useUpdateAgentIntegration()
  if (!teams) return null

  return <DetailCard label="Teams app connection">
    <div className="space-y-4 text-sm">
      <dl className="space-y-2 text-xs">
        <div><dt className="text-muted-foreground">Directory (tenant) ID</dt><dd className="break-all font-mono">{teams.tenantId}</dd></div>
        <div><dt className="text-muted-foreground">Application (client) ID</dt><dd className="break-all font-mono">{teams.appId}</dd></div>
      </dl>
      {teams.deliveryMode === 'socket' ? <p className="text-xs text-muted-foreground">Delivery method · Socket mode (preview)</p> :
        teams.messagingEndpoint ? <Endpoint url={teams.messagingEndpoint} /> : <p className="text-xs text-muted-foreground">A messaging endpoint is required to receive messages from Teams.</p>}
      <PackageDownload agent={agent} appId={teams.appId} name={integration.name || agent?.name || 'Gamut agent'} canUpdate />
      <details><summary className="cursor-pointer font-medium">Installation instructions</summary>
        <div className="pt-2"><InstallInstructions mode={teams.deliveryMode} /></div>
      </details>
      <details><summary className="cursor-pointer font-medium">Replace client secret</summary>
        <form className="space-y-2 pt-2" onSubmit={async event => {
          event.preventDefault()
          if (!secret.trim() || update.isPending) return
          try {
            await update.mutateAsync({ id: integration.id, config: { clientSecret: secret.trim() } })
            setSecret('')
          } catch { /* The mutation exposes its error below. */ }
        }}>
          <IntegrationSetupField id="teams-replacement-secret" label="New client secret value" type="password" autoComplete="new-password" value={secret} onChange={event => { update.reset(); setSecret(event.target.value) }} required />
          <Button size="sm" variant="outline" type="submit" disabled={!secret.trim() || update.isPending}>Save new secret</Button>
          {update.isError && <IntegrationSetupFeedback state="error">{update.error.message}</IntegrationSetupFeedback>}
          {update.isSuccess && <IntegrationSetupFeedback state="success">Client secret updated.</IntegrationSetupFeedback>}
        </form>
      </details>
    </div>
  </DetailCard>
}
