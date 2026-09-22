import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { emailSetupSchema, type EmailAccessLevel } from '@shared/lib/email-integrations/config-schema'
import { EmailAccessFields, parseEmailDomains } from './email-access-fields'
import type { IntegrationSetupProps } from './setup-types'

export function EmailIntegrationSetupForm({ agentSlug, onClose }: IntegrationSetupProps) {
  const { data: agent } = useAgent(agentSlug)
  const { data: platform } = usePlatformAuthStatus()
  const [localPart, setLocalPart] = useState(() => (agent?.name ?? agentSlug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64))
  const [displayName, setDisplayName] = useState(agent?.name ?? agentSlug)
  const [accessLevel, setAccessLevel] = useState<EmailAccessLevel>('agent-users-and-replies')
  const [domains, setDomains] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateAgentIntegration()
  const navigate = useNavigate()
  return <form className="space-y-5 overflow-y-auto max-h-[75vh] p-1" onSubmit={async event => {
    event.preventDefault(); setError(null)
    const parsed = emailSetupSchema.safeParse({ localPart, displayName, accessLevel, allowedDomains: parseEmailDomains(domains) })
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check your email settings'); return }
    try {
      const result = await create.mutateAsync({ agentSlug, provider: 'platform-email', name: parsed.data.displayName, config: parsed.data })
      onClose()
      void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: result.id } })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create inbox') }
  }}>
    <DialogHeader><DialogTitle>Add Email</DialogTitle><DialogDescription>Give this agent an inbox on your company’s Platform domain. Each inbox belongs to one agent.</DialogDescription></DialogHeader>
    <div className="space-y-2"><Label htmlFor="email-name">Sender name</Label><Input id="email-name" value={displayName} onChange={e => setDisplayName(e.target.value)} required maxLength={200} /></div>
    <div className="space-y-2"><Label htmlFor="email-slug">Inbox name</Label><Input id="email-slug" value={localPart} onChange={e => setLocalPart(e.target.value)} required maxLength={64} /><p className="text-xs text-muted-foreground">{localPart || 'assistant'}@your-company-domain. The assigned address stays fixed when you rename the agent. Domain setup can take a few minutes.</p></div>
    <EmailAccessFields value={accessLevel} onChange={setAccessLevel} domains={domains} onDomainsChange={setDomains} disabled={create.isPending} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!platform?.connected && <p role="alert">Connect Platform to set up email.</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={create.isPending || !platform?.connected}>{create.isPending ? 'Creating inbox…' : 'Create inbox'}</Button></div>
  </form>
}
