import { useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { emailSetupSchema, type EmailAccessLevel } from '@shared/lib/email-integrations/config-schema'
import { EmailAccessFields, parseEmailDomains } from './email-access-fields'
import { IntegrationSetupLayout, IntegrationSetupField, IntegrationSetupFeedback } from './integration-setup-layout'
import type { IntegrationSetupProps } from './setup-types'

export function EmailIntegrationSetupForm({ agentSlug, onClose }: IntegrationSetupProps) {
  const formId = useId()
  const { data: agent } = useAgent(agentSlug)
  const { data: platform } = usePlatformAuthStatus()
  const [localPart, setLocalPart] = useState(() => (agent?.name ?? agentSlug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64))
  const [displayName, setDisplayName] = useState(agent?.name ?? agentSlug)
  const [accessLevel, setAccessLevel] = useState<EmailAccessLevel>('agent-users-and-replies')
  const [domains, setDomains] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateAgentIntegration()
  const navigate = useNavigate()

  return <IntegrationSetupLayout
    provider="platform-email"
    label="Email"
    instructions={<>
      <ol className="list-decimal list-outside ml-5 space-y-2.5 text-sm font-normal text-foreground">
        <li>Choose the sender name people will see and a unique inbox name for this agent.</li>
        <li>Choose who can email the agent and who it can email.</li>
        <li>Click Create inbox. Your company’s email domain will be configured automatically if needed.</li>
      </ol>
      <p className="text-xs text-muted-foreground">Each inbox belongs to one agent, with an address like assistant@company.ongamut.so. Renaming the sender later keeps the address fixed.</p>
      <p className="text-xs text-muted-foreground">Domain setup can take a few minutes. Once connected, send an email to start a conversation.</p>
    </>}
    feedback={<>
      {error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
      {!platform?.connected && <IntegrationSetupFeedback state="error">Connect Platform to set up email.</IntegrationSetupFeedback>}
    </>}
    actions={<Button size="sm" type="submit" form={formId} disabled={create.isPending || !platform?.connected}>
      {create.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating inbox…</> : 'Create inbox'}
    </Button>}
  >
    <form id={formId} className="space-y-3" onSubmit={async event => {
      event.preventDefault()
      if (create.isPending) return
      setError(null)
      const parsed = emailSetupSchema.safeParse({ localPart, displayName, accessLevel, allowedDomains: parseEmailDomains(domains) })
      if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check your email settings'); return }
      try {
        const result = await create.mutateAsync({ agentSlug, provider: 'platform-email', name: parsed.data.displayName, config: parsed.data })
        onClose()
        void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: result.id } })
      } catch (err) { setError(err instanceof Error ? err.message : 'Could not create inbox') }
    }}>
      <IntegrationSetupField id="email-name" label="Sender name" value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={200} disabled={create.isPending} />
      <IntegrationSetupField id="email-slug" label="Inbox name" value={localPart} onChange={event => setLocalPart(event.target.value)} required maxLength={64} disabled={create.isPending} />
      <EmailAccessFields value={accessLevel} onChange={setAccessLevel} domains={domains} onDomainsChange={setDomains} disabled={create.isPending} />
    </form>
  </IntegrationSetupLayout>
}
