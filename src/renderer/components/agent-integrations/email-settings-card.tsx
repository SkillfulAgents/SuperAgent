import { useState } from 'react'
import { z } from 'zod'
import { emailAccessSchema } from '@shared/lib/email-integrations/config-schema'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { Button } from '@renderer/components/ui/button'
import { EmailAccessFields, parseEmailDomains } from './email-access-fields'
const settingsSchema = z.object({ address: z.string(), accessLevel: emailAccessSchema, allowedDomains: z.array(z.string()) })
export function EmailSettingsCard({ integration, canManageAccess }: { integration: PublicAgentIntegration; canManageAccess?: boolean }) {
  const settings = settingsSchema.parse(integration.settings)
  const [accessLevel, setAccessLevel] = useState(settings.accessLevel)
  const [domains, setDomains] = useState(settings.allowedDomains.join(', '))
  const update = useUpdateAgentIntegration()
  return <DetailCard label="Email Settings"><div className="space-y-4">
    <p className="text-sm break-all" aria-label="Inbox address">{settings.address}</p>
    <p className="text-xs text-muted-foreground">One conversation per email thread. Renaming changes the sender name, not the address.</p>
    <EmailAccessFields value={accessLevel} onChange={setAccessLevel} domains={domains} onDomainsChange={setDomains} disabled={!canManageAccess || update.isPending} />
    {canManageAccess && <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: integration.id, config: { accessLevel, allowedDomains: parseEmailDomains(domains) } })}>Save email access</Button>}
    {update.isError && <p role="alert" className="text-xs text-destructive">{update.error.message}</p>}
    {update.isSuccess && <p role="status" className="text-xs text-muted-foreground">Email access saved.</p>}
  </div></DetailCard>
}
