import { Close as PopoverClose } from '@radix-ui/react-popover'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { AppLink } from '@renderer/components/ui/app-link'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useUser } from '@renderer/context/user-context'
import { useAgentShareRoster } from '@renderer/hooks/use-agent-member-agents'
import { apiFetch } from '@renderer/lib/api'
import type { MemberAgentRole } from '@shared/lib/types/agent-sharing'
import { AgentAvatar } from './agent-avatar/agent-avatar'

export function AgentShareRows({ agentSlug }: { agentSlug: string }) {
  const roster = useAgentShareRoster(agentSlug)
  const { canUseAgent } = useUser()
  const client = useQueryClient()
  const edit = useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async ({ caller, role }: { caller: string; role: MemberAgentRole | 'remove' }) => {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/member-agents/${encodeURIComponent(caller)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not update agent access')
    },
    onSuccess: (_, { caller }) => Promise.all([
      client.invalidateQueries({ queryKey: ['home-graph'] }),
      client.invalidateQueries({ queryKey: ['x-agent-policies', caller] }),
      client.invalidateQueries({ queryKey: ['inbound-x-agent', agentSlug] }),
    ]),
  })
  if (roster.isError) return <button type="button" className="px-2 py-1.5 text-xs underline" onClick={() => void roster.refetch()}>Retry loading agent access</button>
  if (!roster.data) return null
  const { direct, global } = roster.data
  return <>
    {direct.map(agent => {
      const canEditRole = canUseAgent(agentSlug) && canUseAgent(agent.slug)
      return <div key={agent.slug} className="flex items-center gap-2 rounded-item px-2 py-1.5 hover:bg-accent/50">
        <AgentAvatar agent={agent} size={28} still />
        <div className="min-w-0 flex-1 text-[11px]"><p className="truncate">{agent.name}</p><p className="text-muted-foreground">Agent</p></div>
        {canEditRole ? (
          <Select value={agent.role} disabled={edit.isPending} onValueChange={(role: MemberAgentRole | 'remove') => edit.mutate({ caller: agent.slug, role })}>
            <SelectTrigger aria-label={`Role for ${agent.name}`} data-testid={`access-agent-role-${agent.slug}`}
              className="h-7 w-auto gap-1 border-none bg-transparent px-1.5 text-[11px] text-muted-foreground shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="user" disabled={!agent.canMessage}>User</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
              <SelectSeparator />
              <SelectItem value="remove" className="text-destructive">Remove</SelectItem>
            </SelectContent>
          </Select>
        ) : <span className="px-1.5 text-[11px] capitalize text-muted-foreground">{agent.role}</span>}
      </div>
    })}
    {edit.error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{edit.error.message}</p>}
    {global.length > 0 && <details className="group/globals mt-1 border-t pt-1">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-item px-2 py-2 text-xs text-muted-foreground hover:bg-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 group-open/globals:rotate-90" />
        + {global.length} {global.length === 1 ? 'agent' : 'agents'} with global access
      </summary>
      {global.map(agent => <PopoverClose asChild key={agent.slug}>
        <AppLink to="/agents/$slug/x-agent-permissions" params={{ slug: agent.slug }} className="flex items-center gap-2 rounded-item px-2 py-1.5 text-xs hover:bg-accent">
          <AgentAvatar agent={agent} size={22} still /><span className="flex-1 truncate">{agent.name}</span><ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </AppLink>
      </PopoverClose>)}
    </details>}
  </>
}
