import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { Loader2 } from 'lucide-react'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { startViewTransition } from '@renderer/lib/view-transition'
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

interface ConnectionAgentsListProps {
  type: 'oauth' | 'mcp'
  id: string
  name: string
  /**
   * Split agents into two sectioned lists ("Agents With Access" / "Agents
   * Without Access") instead of one flat list — matches the per-agent
   * connections page pattern. Defaults to a single flat list.
   */
  sectioned?: boolean
}

/**
 * List of agents that can use a given connection, with access toggles that
 * auto-save on change. Rendered on the connection detail page.
 */
export function ConnectionAgentsList({ type, id, name, sectioned = false }: ConnectionAgentsListProps) {
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
    // Optimistically flip the agent into its new section. In the sectioned
    // layout, wrap it in a View Transition (flushSync so the optimistic state
    // hits the DOM before the "before" snapshot) so the row animates between
    // With/Without Access — matching the per-agent connections list.
    const applyOverride = () => setOverrides((prev) => ({ ...prev, [slug]: next }))
    if (sectioned) {
      startViewTransition(() => flushSync(applyOverride))
    } else {
      applyOverride()
    }
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
      // Mirror the optimistic path: in the sectioned layout the set above is
      // deferred inside a view transition, and update callbacks run in queue
      // order — reverting directly would let a fast failure land BEFORE the
      // optimistic set and leave the agent stuck in the wrong section.
      const revertOverride = () => setOverrides((prev) => {
        const n = { ...prev }
        delete n[slug]
        return n
      })
      if (sectioned) {
        startViewTransition(() => flushSync(revertOverride))
      } else {
        revertOverride()
      }
    }
  }

  if (agentsLoading || isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading agents...
      </div>
    )
  }

  if (visibleAgents.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No agents available.
      </p>
    )
  }

  const renderAgentRow = (agent: ApiAgent) => {
    const granted = overrides[agent.slug] ?? grantedSet.has(agent.slug)
    const pending = isPending(agent.slug)
    return (
      <li
        key={agent.slug}
        className="flex items-center gap-3 px-3 py-2.5"
        // Stable name so the View Transition can pair the row across sections.
        style={sectioned ? ({ viewTransitionName: `connection-agent-${agent.slug}` } as CSSProperties) : undefined}
      >
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{agent.name}</div>
          <div className="text-[11px] text-muted-foreground truncate">{agent.displaySlug}</div>
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
  }

  if (sectioned) {
    // Partition on the optimistic grant state so a toggled agent moves to its
    // new section immediately; the View Transition in handleToggle animates the
    // move, and the override clears once the mutation persists.
    const isGranted = (slug: string) => overrides[slug] ?? grantedSet.has(slug)
    const grantedAgents = visibleAgents.filter((a) => isGranted(a.slug))
    const notGrantedAgents = visibleAgents.filter((a) => !isGranted(a.slug))

    return (
      <div className="space-y-6">
        <div className="space-y-1.5">
          <p className="text-xs font-normal text-muted-foreground px-1">
            Agents With Access
          </p>
          {grantedAgents.length > 0 ? (
            <ul className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">
              {grantedAgents.map((agent) => renderAgentRow(agent))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed bg-background px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground">
                No agents have access yet. Grant one below.
              </p>
            </div>
          )}
        </div>
        {notGrantedAgents.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-normal text-muted-foreground px-1">
              Agents Without Access
            </p>
            <ul className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">
              {notGrantedAgents.map((agent) => renderAgentRow(agent))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  return (
    <ul className="divide-y divide-border/50">
      {visibleAgents.map((agent) => renderAgentRow(agent))}
    </ul>
  )
}
