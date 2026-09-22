import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
type HeldEmail = { id: string; from: string; subject: string | null; text: string; attachments: string[] }
export function EmailHeldMessages({ integrationId }: { integrationId: string }) {
  const client = useQueryClient()
  const key = ['email-held', integrationId]
  const messages = useQuery<{ data: HeldEmail[] }>({ queryKey: key, queryFn: async () => {
    const response = await apiFetch(`/api/agent-integrations/${integrationId}/email-held`)
    if (!response.ok) throw new Error('Could not load held emails')
    return response.json()
  }, refetchInterval: 30000 })
  const release = useMutation({ mutationFn: async (id: string) => {
    const response = await apiFetch(`/api/agent-integrations/${integrationId}/email-held/${id}/release`, { method: 'POST' })
    if (!response.ok) throw new Error('Could not release email. Check the connection and access policy.')
  }, onSuccess: () => client.invalidateQueries({ queryKey: key }) })
  return <div className="space-y-2">
    <p className="text-xs font-medium">Held emails ({messages.data?.data.length ?? 0})</p>
    <p className="text-xs text-muted-foreground">A local filter flags suspicious unsolicited mail. Unsolicited attachments require review. This filter cannot detect every prompt injection.</p>
    {messages.data?.data.map(message => <details key={message.id} className="rounded border p-2 text-xs">
      <summary>{message.subject || '(No subject)'} — {message.from}</summary>
      <pre className="whitespace-pre-wrap break-words my-2 max-h-48 overflow-y-auto">{message.text || '(No plain-text body)'}</pre>
      {!!message.attachments.length && <p>Attachments: {message.attachments.join(', ')}</p>}
      <Button type="button" size="sm" variant="outline" disabled={release.isPending} onClick={() => release.mutate(message.id)}>Allow agent to process</Button>
    </details>)}
    {(release.isError || messages.isError) && <p role="alert" className="text-xs text-destructive">{release.error?.message ?? messages.error?.message}</p>}
  </div>
}
