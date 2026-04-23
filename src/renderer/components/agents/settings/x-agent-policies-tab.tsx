import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, Search, AlertCircle, Users } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
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

interface XAgentPoliciesTabProps {
  agentSlug: string
}

interface PoliciesResponse {
  policies: PolicyRow[]
}

type AgentsResponse = ApiAgent[]

function policyKey(operation: Operation, targetSlug: string | null): string {
  return `${operation}::${targetSlug ?? ''}`
}

export function XAgentPoliciesTab({ agentSlug }: XAgentPoliciesTabProps) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch this caller's stored policies
  const policiesQuery = useQuery<PoliciesResponse>({
    queryKey: ['x-agent-policies', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/x-agent-policies`)
      if (!res.ok) throw new Error('Failed to fetch policies')
      return res.json()
    },
  })

  // Fetch all agents in workspace (for the per-target rows)
  const agentsQuery = useQuery<AgentsResponse>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await apiFetch('/api/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json()
    },
  })

  // Build a fast lookup of (op, targetSlug) → decision
  const policyMap = useMemo(() => {
    const map = new Map<string, Decision>()
    for (const p of policiesQuery.data?.policies ?? []) {
      map.set(policyKey(p.operation, p.targetAgentSlug), p.decision)
    }
    return map
  }, [policiesQuery.data])

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

  // Single mutation: build the full policy set with the change applied, PUT it.
  const savePolicies = useMutation({
    mutationFn: async (params: {
      operation: Operation
      targetSlug: string | null
      decision: DecisionOrDefault
    }) => {
      const key = policyKey(params.operation, params.targetSlug)
      setSavingKey(key)
      setError(null)
      // Build the next full policy list: existing rows minus the one we're changing,
      // plus the new one (unless we're setting it to 'default' which means delete).
      const nextPolicies: Array<{ operation: Operation; targetSlug: string | null; decision: Decision }> = []
      for (const p of policiesQuery.data?.policies ?? []) {
        if (policyKey(p.operation, p.targetAgentSlug) === key) continue
        nextPolicies.push({ operation: p.operation, targetSlug: p.targetAgentSlug, decision: p.decision })
      }
      if (params.decision !== 'default') {
        nextPolicies.push({ operation: params.operation, targetSlug: params.targetSlug, decision: params.decision })
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
    onSettled: () => {
      setSavingKey(null)
    },
  })

  const getDecision = (operation: Operation, targetSlug: string | null): DecisionOrDefault => {
    return policyMap.get(policyKey(operation, targetSlug)) ?? 'default'
  }

  const handleChange = (operation: Operation, targetSlug: string | null) => (next: DecisionOrDefault) => {
    savePolicies.mutate({ operation, targetSlug, decision: next })
  }

  if (policiesQuery.isLoading || agentsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium">Cross-agent permissions</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Decisions this agent has remembered for using other agents in this workspace. Set to{' '}
          <span className="font-medium">Allow</span> to skip the prompt;{' '}
          <span className="font-medium">Review</span> (or no policy) prompts every time;{' '}
          <span className="font-medium">Block</span> denies without prompting.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* List Agents global toggle */}
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">List Agents</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Whether this agent can call <code className="font-mono">list_agents</code> to see other workspace agents.
            </p>
          </div>
          <PolicyDecisionToggle
            value={getDecision('list', null)}
            onChange={handleChange('list', null)}
            size="md"
          />
        </div>
      </div>

      {/* Per-agent permissions */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase text-muted-foreground">Per-agent permissions</h4>
          {otherAgents.length > 0 && (
            <div className="relative w-48">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter agents..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-7 pl-7 text-xs"
              />
            </div>
          )}
        </div>

        {otherAgents.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No other agents in this workspace yet.
          </p>
        ) : (
          <div className="mt-2 space-y-1">
            {/* Column headers */}
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground">
              <span>Agent</span>
              <span className="text-center w-[120px]">Read sessions</span>
              <span className="text-center w-[120px]">Send messages</span>
            </div>
            {otherAgents.map((agent) => {
              const readKey = policyKey('read', agent.slug)
              const invokeKey = policyKey('invoke', agent.slug)
              const isSavingRow = savingKey === readKey || savingKey === invokeKey
              const invokeDecision = getDecision('invoke', agent.slug)
              const readDecision = getDecision('read', agent.slug)
              return (
                <div
                  key={agent.slug}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded border px-2 py-2"
                  data-testid={`x-agent-policy-row-${agent.slug}`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    <div className="truncate text-[10px] font-mono text-muted-foreground">{agent.slug}</div>
                  </div>
                  <div className="w-[120px] flex justify-center">
                    <PolicyDecisionToggle
                      value={readDecision}
                      onChange={handleChange('read', agent.slug)}
                    />
                  </div>
                  <div className="w-[120px] flex justify-center">
                    <PolicyDecisionToggle
                      value={invokeDecision}
                      onChange={handleChange('invoke', agent.slug)}
                    />
                  </div>
                  {isSavingRow && (
                    <div className="col-span-3 -mt-1 text-right text-[10px] text-muted-foreground">
                      Saving…
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          <span className="font-medium">Read</span> and <span className="font-medium">Send messages</span> are independent.
          Allow only Send for &quot;trigger but don&apos;t browse history&quot;; allow only Read for view-only access.
          Sync invoke responses are always returned to the caller — they don&apos;t require Read.
        </p>
      </div>
    </div>
  )
}
