import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, Search, AlertCircle, ChevronDown } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { PolicyDecisionDropdown } from '@renderer/components/ui/policy-decision-toggle'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { startViewTransition } from '@renderer/lib/view-transition'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useRenderTracker } from '@renderer/lib/perf'
import type { ApiAgent } from '@renderer/hooks/use-agents'

type Operation = 'list' | 'read' | 'invoke'
type Decision = 'allow' | 'review' | 'block'
type DecisionOrDefault = Decision | 'default'

interface PolicyRow {
  id: string
  operation: Operation
  targetAgentSlug: string | null
  targetAgentName: string | null
  decision: Decision
  updatedAt: string
}

interface XAgentPermissionsViewProps {
  agentSlug: string
}

interface PoliciesResponse {
  policies: PolicyRow[]
}

interface PolicyChange {
  operation: Operation
  targetSlug: string | null
  decision: DecisionOrDefault
}

type AgentsResponse = ApiAgent[]

function policyKey(operation: Operation, targetSlug: string | null): string {
  return `${operation}::${targetSlug ?? ''}`
}

/**
 * Standalone page for an agent's agent-to-agent connections — the policies
 * this agent has remembered for listing, reading, and messaging other
 * workspace agents. Presented like the Agent Connections page: a Switch per
 * target agent ("connected" = it may send messages, the same relationship a
 * drawn home-graph edge creates). Connected rows carry a Permissions popover
 * with the fine-grained controls (Read / Send × Allow / Review / Block);
 * every state is reachable by connecting first, then tuning there.
 */
export function XAgentPermissionsView({ agentSlug }: XAgentPermissionsViewProps) {
  useRenderTracker('XAgentPermissionsView')
  const navigate = useNavigate()
  const { track } = useAnalyticsTracking()
  const queryClient = useQueryClient()
  const { isAuthMode, rolesReady, canAdminAgent } = useUser()
  const canManage = !isAuthMode || (rolesReady && canAdminAgent(agentSlug))
  const [filter, setFilter] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Optimistic per-slug connected state so a toggled row animates to its new
   * section immediately (mirrors connections-list grantOverrides). Cleared by
   * the catch-up effect below once the server state agrees.
   */
  const [connectOverrides, setConnectOverrides] = useState<Record<string, boolean>>({})

  useEffect(() => {
    track('agent_permissions_viewed', { agentSlug })
  }, [track, agentSlug])

  // Reset transient UI state when switching agents via the sidebar.
  useEffect(() => {
    setFilter('')
    setSearchOpen(false)
    setError(null)
    setConnectOverrides({})
  }, [agentSlug])

  // Fetch this caller's stored policies
  const policiesQuery = useQuery<PoliciesResponse>({
    queryKey: ['x-agent-policies', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/x-agent-policies`)
      if (!res.ok) throw new Error('Failed to fetch policies')
      return res.json()
    },
    enabled: canManage,
  })

  // Fetch all agents in workspace (for the per-target rows)
  const agentsQuery = useQuery<AgentsResponse>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
    enabled: canManage,
  })

  // Build a fast lookup of (op, targetSlug) → decision
  const policyMap = useMemo(() => {
    const map = new Map<string, Decision>()
    for (const p of policiesQuery.data?.policies ?? []) {
      map.set(policyKey(p.operation, p.targetAgentSlug), p.decision)
    }
    return map
  }, [policiesQuery.data])

  const getDecision = (operation: Operation, targetSlug: string | null): DecisionOrDefault => {
    return policyMap.get(policyKey(operation, targetSlug)) ?? 'default'
  }

  const globalRead = getDecision('read', null)
  const globalInvoke = getDecision('invoke', null)

  /** Effective send decision: explicit row, else the global default, else review. */
  const effectiveInvoke = (slug: string): Decision => {
    const explicit = getDecision('invoke', slug)
    if (explicit !== 'default') return explicit
    return globalInvoke !== 'default' ? globalInvoke : 'review'
  }

  /** "Connected" = this agent may send messages to the target without a prompt. */
  const serverConnected = (slug: string): boolean => effectiveInvoke(slug) === 'allow'
  const isConnected = (slug: string): boolean => connectOverrides[slug] ?? serverConnected(slug)

  // Drop overrides the server has caught up to. Self-terminating: the setter
  // returns the same reference when nothing changed, so React bails out.
  useEffect(() => {
    if (Object.keys(connectOverrides).length === 0) return
    setConnectOverrides((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [slug, v] of Object.entries(prev)) {
        if (serverConnected(slug) === v) {
          delete next[slug]
          changed = true
        }
      }
      return changed ? next : prev
    })
    // serverConnected is derived from policyMap; policyMap identity is the real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyMap, connectOverrides])

  const otherAgents = useMemo(() => {
    const all = agentsQuery.data ?? []
    return all
      .filter((a) => a.slug !== agentSlug)
      .filter((a) =>
        filter
          ? a.name.toLowerCase().includes(filter.toLowerCase()) ||
            a.slug.toLowerCase().includes(filter.toLowerCase())
          : true,
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agentsQuery.data, agentSlug, filter])

  // Single mutation: build the full policy set with the changes applied, PUT it.
  const savePolicies = useMutation({
    meta: { skipGlobalErrorToast: true },
    mutationFn: async (changes: PolicyChange[]) => {
      setError(null)
      const changed = new Set(changes.map((c) => policyKey(c.operation, c.targetSlug)))
      const nextPolicies: Array<{ operation: Operation; targetSlug: string | null; decision: Decision }> = []
      for (const p of policiesQuery.data?.policies ?? []) {
        if (changed.has(policyKey(p.operation, p.targetAgentSlug))) continue
        nextPolicies.push({ operation: p.operation, targetSlug: p.targetAgentSlug, decision: p.decision })
      }
      for (const c of changes) {
        if (c.decision !== 'default') {
          nextPolicies.push({ operation: c.operation, targetSlug: c.targetSlug, decision: c.decision })
        }
      }
      const res = await apiFetch(`/api/agents/${agentSlug}/x-agent-policies`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policies: nextPolicies }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save policy')
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['x-agent-policies', agentSlug] })
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const handleChange = (operation: Operation, targetSlug: string | null) => (next: DecisionOrDefault) => {
    savePolicies.mutate([{ operation, targetSlug, decision: next }])
  }

  /** The Switch spinner: an in-flight change to this slug's send policy. */
  const isSwitchPending = (slug: string): boolean =>
    savePolicies.isPending &&
    (savePolicies.variables ?? []).some((c) => c.targetSlug === slug && c.operation === 'invoke')

  /** The detail panel's saving hint: any in-flight change for this slug. */
  const isRowSaving = (slug: string): boolean =>
    savePolicies.isPending && (savePolicies.variables ?? []).some((c) => c.targetSlug === slug)

  const setOverride = (slug: string, value: boolean | null) => {
    startViewTransition(() => {
      flushSync(() => {
        setConnectOverrides((prev) => {
          const next = { ...prev }
          if (value === null) delete next[slug]
          else next[slug] = value
          return next
        })
      })
    })
  }

  const handleToggle = (slug: string, next: boolean) => {
    if (next) {
      // Connect = grant Send (the graph-edge relationship). The connected
      // row's Permissions popover is where Read is granted or Send dialed
      // back. Deliberately replaces an explicit Block, like drawing the edge
      // on the graph does.
      setOverride(slug, true)
      savePolicies.mutate([{ operation: 'invoke', targetSlug: slug, decision: 'allow' }], {
        onError: () => setOverride(slug, null),
      })
      return
    }
    // Disconnect: remove the explicit send grant; when connected only via the
    // global default, pin an explicit Review so this one agent prompts again.
    const explicit = getDecision('invoke', slug)
    const decision: DecisionOrDefault = explicit !== 'default' ? 'default' : 'review'
    setOverride(slug, false)
    savePolicies.mutate([{ operation: 'invoke', targetSlug: slug, decision }], {
      onError: () => setOverride(slug, null),
    })
  }

  const renderAgentRow = (agent: ApiAgent) => {
    const slug = agent.slug
    const connected = isConnected(slug)
    const blocked = effectiveInvoke(slug) === 'block'
    const pending = isSwitchPending(slug)
    return (
      <div key={slug} data-testid={`x-agent-policy-row-${slug}`}>
        <IntegrationRow
          icon={null}
          name={agent.name}
          nameBadge={
            blocked ? (
              <span className="rounded px-1 py-0.5 font-medium bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-400">
                Blocked
              </span>
            ) : undefined
          }
          subtitle={<span className="font-mono truncate">{agent.displaySlug}</span>}
          viewTransitionName={`xagent-${slug}`}
          right={
            <>
              {connected && !pending && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="mr-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground opacity-0 translate-x-1 transition-all duration-200 ease-out group-hover:opacity-100 group-hover:translate-x-0 focus-visible:opacity-100 focus-visible:translate-x-0 data-[state=open]:opacity-100 data-[state=open]:translate-x-0"
                      aria-label={`Permissions for ${agent.name}`}
                      data-testid={`x-agent-permissions-trigger-${slug}`}
                    >
                      Permissions
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-72 p-3 space-y-2.5"
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    data-testid={`x-agent-permissions-popover-${slug}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="whitespace-nowrap text-xs font-medium">Read sessions</span>
                      <PolicyDecisionDropdown
                        value={getDecision('read', slug)}
                        onChange={handleChange('read', slug)}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="whitespace-nowrap text-xs font-medium">Send messages</span>
                      <PolicyDecisionDropdown
                        value={getDecision('invoke', slug)}
                        onChange={handleChange('invoke', slug)}
                      />
                    </div>
                    {isRowSaving(slug) && (
                      <div className="text-right text-[10px] text-muted-foreground">Saving…</div>
                    )}
                  </PopoverContent>
                </Popover>
              )}
              {pending ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-label="Saving connection change"
                  data-testid={`x-agent-connect-pending-${slug}`}
                />
              ) : (
                <Switch
                  checked={connected}
                  onCheckedChange={(next) => handleToggle(slug, next)}
                  aria-label={`${connected ? 'Disconnect' : 'Connect'} ${agent.name}`}
                  data-testid={`x-agent-connect-switch-${slug}`}
                />
              )}
            </>
          }
        />
      </div>
    )
  }

  const connectedAgents = otherAgents.filter((a) => isConnected(a.slug))
  const notConnectedAgents = otherAgents.filter((a) => !isConnected(a.slug))

  return (
    <SettingsPageContainer>
      <PageTitle
        title="Connect this agent to others"
        back={{
          onClick: () => {
            void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
          },
          testId: 'x-agent-permissions-back-button',
        }}
      />

      {isAuthMode && !rolesReady ? (
        <p className="text-sm text-muted-foreground">Checking permissions...</p>
      ) : !canManage ? (
        <div className="rounded-xl border bg-background px-6 py-10 text-center" data-testid="x-agent-permissions-no-permission">
          <p className="text-sm font-medium">Owner access required</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Only agent owners can view and manage agent-to-agent connections.
          </p>
        </div>
      ) : policiesQuery.isLoading || agentsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-6">
          {error && (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {/* Global toggles (apply to every agent in the workspace) */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium uppercase text-muted-foreground">Global permissions</h4>
            <div className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 text-xs font-medium">
                  Allow this agent to see a list of all other agents
                </span>
                <PolicyDecisionDropdown
                  value={getDecision('list', null)}
                  onChange={handleChange('list', null)}
                />
              </div>
            </div>
            <div className="rounded-md border p-3" data-testid="x-agent-policy-global-read">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 text-xs font-medium">
                  Allow this agent to read sessions of all other agents
                </span>
                <PolicyDecisionDropdown
                  value={globalRead}
                  onChange={handleChange('read', null)}
                />
              </div>
            </div>
            <div className="rounded-md border p-3" data-testid="x-agent-policy-global-invoke">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 text-xs font-medium">
                  Allow this agent to send messages to all other agents
                </span>
                <PolicyDecisionDropdown
                  value={globalInvoke}
                  onChange={handleChange('invoke', null)}
                />
              </div>
            </div>
          </div>

          {/* Per-agent connections */}
          {agentsQuery.data && agentsQuery.data.filter((a) => a.slug !== agentSlug).length === 0 ? (
            <p className="text-sm text-muted-foreground">No other agents in this workspace yet.</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <p className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground">
                    Connected
                  </p>
                  {searchOpen ? (
                    <div className="relative w-44 max-w-full">
                      <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <Input
                        autoFocus
                        placeholder="Filter agents..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onBlur={() => {
                          if (!filter.trim()) setSearchOpen(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setFilter('')
                            setSearchOpen(false)
                          }
                        }}
                        className="h-6 text-xs pl-6"
                      />
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-6 w-6 px-0 text-muted-foreground"
                      aria-label="Search agents"
                      data-testid="x-agent-search-toggle"
                      onClick={() => setSearchOpen(true)}
                    >
                      <Search className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {connectedAgents.length > 0 ? (
                  <IntegrationList>{connectedAgents.map(renderAgentRow)}</IntegrationList>
                ) : (
                  <div className="rounded-xl border border-dashed bg-background px-4 py-6 text-center">
                    <p className="text-xs text-muted-foreground">
                      {filter
                        ? 'No connected agents match the filter.'
                        : "This agent isn't connected to any other agents yet. Toggle one on below."}
                    </p>
                  </div>
                )}
              </div>
              {notConnectedAgents.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground px-1">
                    Not connected
                  </p>
                  <IntegrationList>{notConnectedAgents.map(renderAgentRow)}</IntegrationList>
                </div>
              )}
            </>
          )}

        </div>
      )}
    </SettingsPageContainer>
  )
}
