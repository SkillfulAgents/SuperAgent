import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useAgent } from '@renderer/hooks/use-agents'
import { agentIntegrationKeys } from '@renderer/hooks/use-agent-integrations'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { PublicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/public'

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(`/api/agent-integrations/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) { const error = await response.json(); throw new Error(error.error ?? 'Could not update the integration') }
  return response.json()
}
function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href} target="_blank" rel="noreferrer" onClick={event => {
    if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(href) }
  }}>{children}<ExternalLink className="h-3.5 w-3.5" /></a>
}

/** Provider-specific creation step inside the same setup dialog as every integration. */
export function LinearSetupForm({ agentSlug, onClose }: { agentSlug: string; onClose: () => void }) {
  const { data: agent } = useAgent(agentSlug)
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const displayName = name ?? agent?.name ?? agentSlug
  const create = async () => {
    setBusy(true); setError(null)
    try {
      const row = await request<{ id: string }>(`agents/${encodeURIComponent(agentSlug)}/linear`, { name: displayName.trim() })
      await queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
      onClose()
      void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: row.id } })
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create integration') }
    finally { setBusy(false) }
  }
  return <>
    <DialogHeader><DialogTitle className="flex items-center gap-2 font-normal"><ServiceIcon slug="linear" fallback="mcp" className="h-5 w-5 dark:invert" />Set up integration with Linear</DialogTitle>
      <DialogDescription>Give this agent its own identity in your Linear workspace.</DialogDescription></DialogHeader>
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Create a separate private app for this agent using a prefilled form, then authorize its access to your workspace and teams.</p>
      <div className="space-y-1"><Label htmlFor="linear-agent-name">Agent name in Linear</Label><Input id="linear-agent-name" value={displayName} onChange={event => setName(event.target.value)} maxLength={80} /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end"><Button disabled={busy || !displayName.trim()} onClick={() => void create()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Continue</Button></div>
    </div>
  </>
}

/** Only credentials differ by provider; lifecycle, settings and history stay shared. */
export function LinearConnectionSettings({ integration }: { integration: PublicLinearIntegration }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [editCredentials, setEditCredentials] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const linear = integration.linear
  if (!linear) return null
  const needsCredentials = !linear.canReconnect || editCredentials
  const pending = linear.authorizationState === 'pending'
  const authorize = async (useSaved = false) => {
    setBusy(true); setError(null); setAuthUrl(null)
    try {
      const result = await request<{ url: string }>(`${integration.id}/authorize`, useSaved ? {} : { clientId, clientSecret })
      setClientSecret(''); setEditCredentials(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.detail(integration.id) }),
        queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.status(integration.id) }),
        queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(integration.agentSlug) }),
      ])
      setAuthUrl(result.url)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not authorize integration') }
    finally { setBusy(false) }
  }
  return <DetailCard label="Linear Account">
    <div className="space-y-4">
      {linear.identity && <div><p className="text-sm font-medium">{linear.identity.appName}</p><p className="text-xs text-muted-foreground">{linear.identity.workspaceName}</p></div>}
      {linear.authorizationMessage && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">{linear.authorizationMessage}</p>}
      {needsCredentials && <>
        <div className="space-y-2"><p className="text-sm font-medium">1. Create your agent’s app</p>
          <p className="text-xs text-muted-foreground">Use the prefilled form, add an avatar, keep the app private, and leave webhooks off. To reconnect, use the existing app.</p>
          <ExternalButton href={linear.setup.creationUrl}>Create app in Linear</ExternalButton>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Callback URL</summary><p className="mt-2 break-all">{linear.setup.redirectUri}</p></details>
        </div>
        <div className="space-y-3"><p className="text-sm font-medium">2. Copy the app credentials</p>
          <div className="space-y-1"><Label htmlFor="linear-client-id">Client ID</Label><Input id="linear-client-id" autoComplete="off" value={clientId} onChange={event => { setClientId(event.target.value); setAuthUrl(null) }} /></div>
          <div className="space-y-1"><Label htmlFor="linear-client-secret">Client secret</Label><Input id="linear-client-secret" type="password" autoComplete="new-password" value={clientSecret} onChange={event => { setClientSecret(event.target.value); setAuthUrl(null) }} /></div>
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
          <Button size="sm" variant={needsCredentials ? 'default' : 'outline'} disabled={busy || (needsCredentials && (!clientId.trim() || !clientSecret.trim()))} onClick={() => void authorize(!needsCredentials)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{needsCredentials ? 'Continue to authorization' : pending ? 'Start again' : 'Reconnect account'}
          </Button>
          {linear.canReconnect && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditCredentials(!editCredentials); setAuthUrl(null); setError(null) }}>{editCredentials ? 'Cancel' : 'Edit app credentials'}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}
