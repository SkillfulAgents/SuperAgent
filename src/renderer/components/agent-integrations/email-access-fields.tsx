import { useUser } from '@renderer/context/user-context'
import { useAgentIntegrationSetup } from '@renderer/hooks/use-agent-integrations'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { Label } from '@renderer/components/ui/label'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import type { EmailAccessLevel } from '@shared/lib/email-integrations/config-schema'

export const emailAccessOptions = [
  { value: 'agent-users', label: 'Agent users only', description: 'Send to and accept mail from verified agent users and owners only.' },
  { value: 'agent-users-and-replies', label: 'Agent users + replies', description: 'Agent users can start conversations. The agent can email anyone and accept their replies in that thread.' },
  { value: 'allowed-domains', label: 'Allowed domains only', description: 'Send to and accept mail only from these domains. Subdomains must be listed separately.' },
  { value: 'anyone', label: 'Anyone', description: 'Anyone can start an email conversation and the agent can email anyone.' },
] as const
export function EmailAccessFields({ value, onChange, domains, onDomainsChange, disabled = false, agentSlug, canPreview = true }: {
  agentSlug: string; canPreview?: boolean
  value: EmailAccessLevel; onChange: (value: EmailAccessLevel) => void; domains: string; onDomainsChange: (value: string) => void; disabled?: boolean
}) {
  const { user, isAuthMode } = useUser()
  const { data: platform } = usePlatformAuthStatus()
  const setup = useAgentIntegrationSetup(agentSlug, 'platform-email', undefined, canPreview)
  const yourEmail = (isAuthMode ? user?.email : platform?.email)?.toLowerCase()
  const members = setup.data?.agentUserEmails
  const restrictedToUsers = value === 'agent-users' || value === 'agent-users-and-replies'
  return <div className="space-y-3">
    <Label htmlFor="email-access">Email access</Label>
    <Select value={value} onValueChange={v => onChange(v as EmailAccessLevel)} disabled={disabled}>
      <SelectTrigger id="email-access"><SelectValue /></SelectTrigger>
      <SelectContent>{emailAccessOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
    {value === 'allowed-domains' && <div className="space-y-2"><Label htmlFor="email-domains">Allowed domains</Label><Input id="email-domains" placeholder="company.com, team.company.com" value={domains} onChange={e => onDomainsChange(e.target.value)} disabled={disabled} /></div>}
    <div className="space-y-1.5 text-xs text-muted-foreground" aria-live="polite">
      <p>{value === 'anyone' ? 'This agent will accept emails from:' : 'This agent will only accept emails from:'}</p>
      <ul className="list-disc pl-5 space-y-1 break-words">
        {restrictedToUsers && <>
          {canPreview && members ? members.map(email => <li key={email}>{email === yourEmail ? `You (${email})` : email}</li>)
            : <li>{!canPreview ? 'Agent users (an owner can view the email list).' : setup.isPending ? 'Loading permitted email addresses…' : 'Could not load permitted email addresses.'}</li>}
          {canPreview && members?.length === 0 && <li>No agent users currently have a permitted email address.</li>}
          {value === 'agent-users-and-replies' && <li>People it has reached out to, when they reply in the same email thread.</li>}
        </>}
        {value === 'allowed-domains' && (parseEmailDomains(domains).length
          ? parseEmailDomains(domains).map(domain => <li key={domain}>Anyone with an email address at @{domain}</li>)
          : <li>No one until you add an allowed domain.</li>)}
        {value === 'anyone' && <li>Anyone</li>}
      </ul>
      <p>{value === 'agent-users' ? 'It can only send emails to the addresses listed above.'
        : value === 'allowed-domains' ? 'It can only send emails to these domains. Subdomains must be listed separately.'
          : 'It can send emails to anyone.'}</p>
    </div>
    {value === 'anyone' && <p role="note" className="text-xs text-amber-700 dark:text-amber-400">Public inbox: external emails can invoke this agent and its enabled tools. Keep approval requirements enabled for sensitive actions.</p>}
    <p className="text-xs text-muted-foreground">Protected modes require sender-domain authentication. Email cannot approve privileged actions.</p>
  </div>
}
export function parseEmailDomains(value: string) { return [...new Set(value.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean))] }
