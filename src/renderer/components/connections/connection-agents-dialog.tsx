import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Switch } from '@renderer/components/ui/switch'
import { useAgents } from '@renderer/hooks/use-agents'
import { useUser } from '@renderer/context/user-context'
import {
  useAccountAgents,
  useAssignAccountsToAgent,
  useRemoveAgentConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import {
  useMcpAgents,
  useAssignMcpToAgent,
  useRemoveMcpFromAgent,
} from '@renderer/hooks/use-remote-mcps'

interface ConnectionAgentsDialogProps {
  type: 'oauth' | 'mcp'
  id: string
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectionAgentsDialog({ type, id, name, open, onOpenChange }: ConnectionAgentsDialogProps) {
  const { isAuthMode, rolesReady, canAdminAgent } = useUser()
  const { data: agents, isLoading: agentsLoading } = useAgents()

  const accountAgents = useAccountAgents(type === 'oauth' ? id : '')
  const mcpAgents = useMcpAgents(type === 'mcp' ? id : '')
  const data = type === 'oauth' ? accountAgents.data : mcpAgents.data
  const isLoading = type === 'oauth' ? accountAgents.isLoading : mcpAgents.isLoading

  const assignAccount = useAssignAccountsToAgent()
  const removeAccount = useRemoveAgentConnectedAccount()
  const assignMcp = useAssignMcpToAgent()
  const removeMcp = useRemoveMcpFromAgent()

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!open) setOverrides({})
  }, [open])

  const grantedSet = useMemo(
    () => new Set(data?.agentSlugs ?? []),
    [data],
  )

  useEffect(() => {
    if (Object.keys(overrides).length === 0) return
    setOverrides((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [slug, val] of Object.entries(prev)) {
        if (grantedSet.has(slug) === val) {
          delete next[slug]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [grantedSet, overrides])

  const visibleAgents = useMemo(() => {
    if (!agents) return []
    if (isAuthMode && rolesReady) {
      return agents.filter((a) => canAdminAgent(a.slug))
    }
    return agents
  }, [agents, isAuthMode, rolesReady, canAdminAgent])

  const isPending = (slug: string): boolean => {
    if (type === 'oauth') {
      if (assignAccount.isPending && assignAccount.variables?.agentSlug === slug && assignAccount.variables?.accountIds.includes(id)) return true
      if (removeAccount.isPending && removeAccount.variables?.agentSlug === slug && removeAccount.variables?.accountId === id) return true
      return false
    }
    if (assignMcp.isPending && assignMcp.variables?.agentSlug === slug && assignMcp.variables?.mcpIds.includes(id)) return true
    if (removeMcp.isPending && removeMcp.variables?.agentSlug === slug && removeMcp.variables?.mcpId === id) return true
    return false
  }

  const handleToggle = async (slug: string, next: boolean) => {
    setOverrides((prev) => ({ ...prev, [slug]: next }))
    try {
      if (type === 'oauth') {
        if (next) {
          await assignAccount.mutateAsync({ agentSlug: slug, accountIds: [id] })
        } else {
          await removeAccount.mutateAsync({ agentSlug: slug, accountId: id })
        }
      } else {
        if (next) {
          await assignMcp.mutateAsync({ agentSlug: slug, mcpIds: [id] })
        } else {
          await removeMcp.mutateAsync({ agentSlug: slug, mcpId: id })
        }
      }
    } catch {
      setOverrides((prev) => {
        const n = { ...prev }
        delete n[slug]
        return n
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onClick={(e) => e.stopPropagation()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Agents with access to {name}</DialogTitle>
          <DialogDescription>
            Toggle which agents can use this connection.
            {isAuthMode ? ' Only agents you own are shown.' : ''}
          </DialogDescription>
        </DialogHeader>

        {agentsLoading || isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading agents...
          </div>
        ) : visibleAgents.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No agents available.
          </p>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto -mx-2">
            <ul className="divide-y divide-border/50">
              {visibleAgents.map((agent) => {
                const granted = overrides[agent.slug] ?? grantedSet.has(agent.slug)
                const pending = isPending(agent.slug)
                return (
                  <li key={agent.slug} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{agent.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{agent.slug}</div>
                    </div>
                    {pending ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={granted}
                        onCheckedChange={(next) => { void handleToggle(agent.slug, next) }}
                        aria-label={`${granted ? 'Revoke' : 'Grant'} ${name} access for ${agent.name}`}
                        data-testid={`connection-agent-toggle-${type}-${id}-${agent.slug}`}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
