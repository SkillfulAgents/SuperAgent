import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ExternalLink, Loader2, Plus } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { useAgent } from '@renderer/hooks/use-agents'
import { useUser } from '@renderer/context/user-context'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@renderer/components/ui/dialog'
import { HomeCollapsible } from '../agents/agent-home/home-collapsible'
import type { publicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/setup'

type LinearIntegration = ReturnType<typeof publicLinearIntegration> & { connected?: boolean }
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/agent-integrations/${path}`, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) { const error = await response.json(); throw new Error(error.error ?? 'Could not update the integration') }
  return response.status === 204 ? undefined as T : response.json()
}
function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href} target="_blank" rel="noreferrer" onClick={event => {
    if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(href) }
  }}>{children}<ExternalLink className="h-3.5 w-3.5" /></a>
}

export function HomeTaskIntegrations({ agentSlug }: { agentSlug: string }) {
  const { data: agent } = useAgent(agentSlug)
  const { canAdminAgent } = useUser()
  const canManage = canAdminAgent(agentSlug)
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [created, setCreated] = useState<LinearIntegration | null>(null)
  const [open, setOpen] = useState(false)
  const { data: rows = [], error } = useQuery({ queryKey: ['task-integrations', agentSlug],
    queryFn: () => request<LinearIntegration[]>(`agents/${encodeURIComponent(agentSlug)}`), refetchInterval: open ? 2500 : 15000 })
  return <HomeCollapsible title="Task Platforms">
    <div className="mx-4 mt-3 space-y-2 pb-3">
      {rows.map(row => <button key={row.id} type="button" onClick={() => { setSelected(row.id); setOpen(true) }}
        className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50">
        <ServiceIcon slug="linear" fallback="mcp" className="h-6 w-6 dark:invert" />
        <span className="flex-1"><span className="block text-sm font-medium">{row.name ?? 'Linear'}</span>
          <span className="text-xs text-muted-foreground">{row.identity?.workspaceName ?? 'Finish setup'} · {row.status === 'active' && row.connected ? 'Connected' : row.status}</span></span>
      </button>)}
      {!rows.length && <div className="rounded-lg border border-dashed p-4">
        <p className="text-xs font-medium">Bring this agent into Linear</p>
        <p className="mt-1 text-xs text-muted-foreground">Give it its own identity, delegate issues, and mention it in comments. Each issue keeps its own session.</p>
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">Could not load task integrations.</p>}
      {canManage && <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setOpen(true) }}><Plus className="h-4 w-4" /> Add Linear</Button>}
    </div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent>
      <LinearSetup key={selected ?? 'new'} agentSlug={agentSlug} agentName={agent?.name ?? agentSlug}
        integration={rows.find(row => row.id === selected) ?? (created?.id === selected ? created : undefined)} canManage={canManage}
        onCreated={row => { setCreated(row); setSelected(row.id) }} onChanged={() => { void queryClient.invalidateQueries({ queryKey: ['task-integrations', agentSlug] }) }} onDeleted={() => setOpen(false)} />
    </DialogContent></Dialog>
  </HomeCollapsible>
}
function LinearSetup({ agentSlug, agentName, integration, canManage, onCreated, onChanged, onDeleted }: {
  agentSlug: string; agentName: string; integration?: LinearIntegration; canManage: boolean;
  onCreated: (row: LinearIntegration) => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(agentName)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [reconnect, setReconnect] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const navigate = useNavigate()
  const id = integration?.id
  const { data: sessions = [] } = useQuery({ queryKey: ['task-integration-sessions', id], enabled: !!id,
    queryFn: () => request<Array<{ id: string; sessionId: string; displayName: string | null; externalChatId: string }>>(`${id}/sessions`) })
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action(); onChanged() } catch (error) { setError(error instanceof Error ? error.message : 'Something went wrong') } finally { setBusy(false) }
  }
  const needsSetup = !integration?.authorized || reconnect
  return <>
    <DialogHeader><DialogTitle className="flex items-center gap-2"><ServiceIcon slug="linear" fallback="mcp" className="h-6 w-6 dark:invert" />{integration?.authorized ? 'Linear integration' : 'Connect to Linear'}</DialogTitle>
      <DialogDescription>Each agent gets a separate private Linear app with its own name and avatar.</DialogDescription></DialogHeader>
    {!id && canManage && <div className="space-y-4">
      <div className="space-y-2"><Label htmlFor="linear-agent-name">Agent name in Linear</Label><Input id="linear-agent-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} /></div>
      <p className="text-sm text-muted-foreground">You’ll create an app using a prefilled form, copy its credentials, then authorize it. A Linear workspace admin may need to approve the app and choose its team access.</p>
      <Button disabled={busy || !name.trim()} onClick={() => void run(async () => { const created = await request<LinearIntegration>(`agents/${encodeURIComponent(agentSlug)}/linear`, 'POST', { name }); onCreated(created) })}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Set up Linear
      </Button>
    </div>}
    {integration && needsSetup && canManage && <div className="space-y-4">
      <div className="space-y-2"><p className="text-sm font-medium">1. Create your agent’s app</p>
        <p className="text-xs text-muted-foreground">Use the prefilled form. Add an avatar, keep the app private, and save it. For reconnecting, use the existing app’s credentials.</p>
        <ExternalButton href={integration.setup.creationUrl}>Create app in Linear</ExternalButton>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Callback and webhook URLs</summary>
          <p className="mt-2 break-all">Callback: {integration.setup.redirectUri}</p><p className="mt-1 break-all">Webhook: {integration.setup.webhookUrl}</p>
        </details>
      </div>
      <div className="space-y-3"><p className="text-sm font-medium">2. Copy the app credentials</p>
        <div className="space-y-1"><Label htmlFor="linear-client-id">Client ID</Label><Input id="linear-client-id" autoComplete="off" value={clientId} onChange={event => setClientId(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="linear-client-secret">Client secret</Label><Input id="linear-client-secret" type="password" autoComplete="new-password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="linear-webhook-secret">Webhook signing secret</Label><Input id="linear-webhook-secret" type="password" autoComplete="new-password" value={webhookSecret} onChange={event => setWebhookSecret(event.target.value)} /></div>
      </div>
      <div className="space-y-2"><p className="text-sm font-medium">3. Authorize this agent</p>
        <p className="text-xs text-muted-foreground">Choose the workspace and teams this agent should access. Approve permission to read, edit, receive mentions, and receive delegated issues.</p>
        {authUrl ? <><ExternalButton href={authUrl}>Authorize in Linear</ExternalButton><p className="text-xs text-muted-foreground">Waiting for authorization. This screen updates automatically.</p></>
          : <Button disabled={busy || !clientId || !clientSecret || !webhookSecret} onClick={() => void run(async () => {
            const result = await request<{ url: string }>(`${id}/authorize`, 'POST', { clientId, clientSecret, webhookSecret }); setAuthUrl(result.url); setClientSecret(''); setWebhookSecret(''); setReconnect(false)
          })}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Continue to authorization</Button>}
      </div>
    </div>}
    {integration?.authorized && !reconnect && <div className="space-y-4">
      <div className="rounded-lg border p-3"><p className="text-sm font-medium">{integration.identity?.appName}</p><p className="text-xs text-muted-foreground">{integration.identity?.workspaceName} · {integration.status}</p></div>
      <p className="text-sm text-muted-foreground">Delegate an issue to this agent or mention it in a comment. Replies return to that issue as a concise comment. Keep Gamut running to receive new work.</p>
      {canManage && <><div className="flex items-center justify-between gap-3"><Label htmlFor="linear-status-trigger" className="text-sm">Run when an involved issue changes status</Label>
        <Switch id="linear-status-trigger" checked={integration.runOnStatusChange} disabled={busy} onCheckedChange={value => void run(async () => { await request(`${id}`, 'PATCH', { runOnStatusChange: value }) })} /></div>
        <div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { await request(`${id}`, 'PATCH', { status: integration.status === 'active' ? 'paused' : 'active' }) })}>{integration.status === 'active' ? 'Pause' : 'Resume'}</Button>
          <Button variant="ghost" size="sm" onClick={() => setReconnect(true)}>Reconnect</Button></div></>}
    </div>}
    {integration?.errorMessage && <p role="status" className="text-sm text-destructive">{integration.errorMessage}</p>}
    {!!sessions.length && <div className="space-y-1 border-t pt-3"><p className="text-xs font-medium">Issue sessions</p>{sessions.slice(0, 10).map(session => <button key={session.id} className="block text-left text-xs text-primary underline" onClick={() => void navigate({ to: '/agents/$slug/sessions/$sessionId', params: { slug: agentSlug, sessionId: session.sessionId } })}>{session.displayName ?? session.externalChatId}</button>)}</div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {id && canManage && <div className="border-t pt-3">{confirmDelete ? <div className="space-y-2"><p className="text-xs text-muted-foreground">Disconnect this agent and remove its local issue bindings? Existing Linear comments remain.</p><Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(async () => { await request(`${id}`, 'DELETE'); onDeleted() })}>Remove integration</Button><Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button></div>
      : <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>Remove integration</Button>}</div>}
  </>
}
