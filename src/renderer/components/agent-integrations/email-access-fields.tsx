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
export function EmailAccessFields({ value, onChange, domains, onDomainsChange, disabled = false }: {
  value: EmailAccessLevel; onChange: (value: EmailAccessLevel) => void; domains: string; onDomainsChange: (value: string) => void; disabled?: boolean
}) {
  return <div className="space-y-3">
    <Label htmlFor="email-access">Email access</Label>
    <Select value={value} onValueChange={v => onChange(v as EmailAccessLevel)} disabled={disabled}>
      <SelectTrigger id="email-access"><SelectValue /></SelectTrigger>
      <SelectContent>{emailAccessOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
    <p className="text-xs text-muted-foreground">{emailAccessOptions.find(option => option.value === value)?.description}</p>
    {value === 'allowed-domains' && <div className="space-y-2"><Label htmlFor="email-domains">Allowed domains</Label><Input id="email-domains" placeholder="company.com, team.company.com" value={domains} onChange={e => onDomainsChange(e.target.value)} disabled={disabled} /></div>}
    {value === 'anyone' && <p role="note" className="text-xs text-amber-700 dark:text-amber-400">Public inbox: external emails can invoke this agent and its enabled tools. Keep approval requirements enabled for sensitive actions.</p>}
    <p className="text-xs text-muted-foreground">Protected modes require sender-domain authentication. Email cannot approve privileged actions.</p>
  </div>
}
export function parseEmailDomains(value: string) { return [...new Set(value.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean))] }
