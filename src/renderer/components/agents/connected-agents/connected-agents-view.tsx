import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Loader2, AlertCircle, Settings } from 'lucide-react'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@renderer/components/ui/dialog'
import { PolicyDecisionToggle } from '@renderer/components/ui/policy-decision-toggle'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import { PageTitle, SettingsPageContainer } from '@renderer/components/layout/settings-page'
import { useSelection } from '@renderer/context/selection-context'
import { startViewTransition } from '@renderer/lib/view-transition'
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

interface ConnectedAgentsViewProps {
  agentSlug: string
}

interface PoliciesResponse {
  policies: PolicyRow[]
}

type AgentsResponse = ApiAgent[]

function policyKey(operation: Operation, targetSlug: string | null): string {
  return `${operation}::${targetSlug ?? ''}`
}

/** A connectable agent target. */
interface RowTarget {
  slug: string
  name: string
}

export function ConnectedAgentsView({ agentSlug }: ConnectedAgentsViewProps) {
  useRenderTracker('ConnectedAgentsView')
  const queryClient = useQueryClient()
  const { setView } = useSelection()
  const [error, setError] = useState<string | null>(null)
  // Permission dialog state (per-agent or the wildcard "all agents" row)
  const [dialogTarget, setDialogTarget] = useState<RowTarget | null>(null)
  const [draftRead, setDraftRead] = useState<DecisionOrDefault>('default')
  const [draftInvoke, setDraftInvoke] = useState<DecisionOrDefault>('default')
  // Optimistic connected/not-connected overrides keyed by agent slug. Keeps a
  // row visually in its new section while the mutation is in-flight so the
  // View Transition can animate the move. Cleared once the server agrees.
  const [connectOverrides, setConnectOverrides] = useState<Record<string, boolean>>({})

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
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [agentsQuery.data, agentSlug])

  // Single mutation: build the full policy set with the change applied, PUT it.
  const savePolicies = useMutation({
    mutationFn: async (params: {
      operation: Operation
      targetSlug: string | null
      decision: DecisionOrDefault
    }) => {
      const key = policyKey(params.operation, params.targetSlug)
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
  })

  // Replace both per-target operations (read + invoke) for one agent in a
  // single PUT. 'default' means "remove the row" → falls back to the global
  // default / interactive review.
  const saveTargetPolicies = useMutation({
    mutationFn: async (params: {
      targetSlug: string | null
      read: DecisionOrDefault
      invoke: DecisionOrDefault
    }) => {
      setError(null)
      const readKey = policyKey('read', params.targetSlug)
      const invokeKey = policyKey('invoke', params.targetSlug)
      const nextPolicies: Array<{ operation: Operation; targetSlug: string | null; decision: Decision }> = []
      for (const p of policiesQuery.data?.policies ?? []) {
        const k = policyKey(p.operation, p.targetAgentSlug)
        if (k === readKey || k === invokeKey) continue
        nextPolicies.push({ operation: p.operation, targetSlug: p.targetAgentSlug, decision: p.decision })
      }
      if (params.read !== 'default') {
        nextPolicies.push({ operation: 'read', targetSlug: params.targetSlug, decision: params.read })
      }
      if (params.invoke !== 'default') {
        nextPolicies.push({ operation: 'invoke', targetSlug: params.targetSlug, decision: params.invoke })
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

  const getDecision = (operation: Operation, targetSlug: string | null): DecisionOrDefault => {
    return policyMap.get(policyKey(operation, targetSlug)) ?? 'default'
  }

  // Server truth: an agent is connected if it has an explicit read or send policy.
  const serverConnected = (targetSlug: string): boolean =>
    getDecision('read', targetSlug) !== 'default' || getDecision('invoke', targetSlug) !== 'default'

  // Effective state = optimistic override (if any) over server truth.
  const isConnected = (targetSlug: string): boolean =>
    connectOverrides[targetSlug] ?? serverConnected(targetSlug)

  const decisionLabel = (d: DecisionOrDefault): string =>
    d === 'allow' ? 'Allow' : d === 'block' ? 'Block' : 'Review'

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policiesQuery.data, connectOverrides])

  // Open the permission dialog (gear icon only) — shows the target's current
  // values for fine-tuning.
  const openPermissionDialog = (target: RowTarget) => {
    setDraftRead(getDecision('read', target.slug))
    setDraftInvoke(getDecision('invoke', target.slug))
    setDialogTarget(target)
  }

  // Toggling the switch connects/disconnects directly — no dialog. Connecting
  // grants Allow for both Read and Send; permissions can be fine-tuned via the
  // gear icon afterwards. The optimistic override + View Transition animate
  // the row moving between the Connected / Not connected sections.
  const handleToggleTarget = (target: RowTarget, next: boolean) => {
    startViewTransition(() => {
      flushSync(() => {
        setConnectOverrides((prev) => ({ ...prev, [target.slug]: next }))
      })
    })
    saveTargetPolicies.mutate(
      next
        ? { targetSlug: target.slug, read: 'allow', invoke: 'allow' }
        : { targetSlug: target.slug, read: 'default', invoke: 'default' },
      {
        onError: () =>
          setConnectOverrides((prev) => {
            const n = { ...prev }
            delete n[target.slug]
            return n
          }),
      },
    )
  }

  const handleSaveDialog = () => {
    if (!dialogTarget) return
    saveTargetPolicies.mutate(
      { targetSlug: dialogTarget.slug, read: draftRead, invoke: draftInvoke },
      { onSuccess: () => setDialogTarget(null) },
    )
  }

  // "Connect to all agents" — a master switch that connects (Allow read+send)
  // or disconnects every agent in the lists below in one request.
  const saveAllAgents = useMutation({
    mutationFn: async (next: boolean) => {
      setError(null)
      const nextPolicies: Array<{ operation: Operation; targetSlug: string | null; decision: Decision }> = []
      for (const p of policiesQuery.data?.policies ?? []) {
        // Preserve the global "list" policy and any workspace-wide (null-target)
        // rows; rebuild every per-agent read/invoke row from scratch.
        if (p.operation === 'list' || p.targetAgentSlug === null) {
          nextPolicies.push({ operation: p.operation, targetSlug: p.targetAgentSlug, decision: p.decision })
        }
      }
      if (next) {
        for (const a of otherAgents) {
          nextPolicies.push({ operation: 'read', targetSlug: a.slug, decision: 'allow' })
          nextPolicies.push({ operation: 'invoke', targetSlug: a.slug, decision: 'allow' })
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
    onError: (err: Error) => setError(err.message),
  })

  const allAgentsConnected =
    otherAgents.length > 0 && otherAgents.every((a) => isConnected(a.slug))

  const handleToggleAllAgents = (next: boolean) => {
    startViewTransition(() => {
      flushSync(() => {
        setConnectOverrides((prev) => {
          const n = { ...prev }
          for (const a of otherAgents) n[a.slug] = next
          return n
        })
      })
    })
    saveAllAgents.mutate(next, {
      onError: () =>
        setConnectOverrides((prev) => {
          const n = { ...prev }
          for (const a of otherAgents) delete n[a.slug]
          return n
        }),
    })
  }

  const connectedAgents = otherAgents.filter((a) => isConnected(a.slug))
  const notConnectedAgents = otherAgents.filter((a) => !isConnected(a.slug))

  const renderTargetRow = (target: RowTarget): ReactNode => {
    const connected = isConnected(target.slug)
    const isSavingRow =
      saveTargetPolicies.isPending && saveTargetPolicies.variables?.targetSlug === target.slug
    return (
      <IntegrationRow
        key={target.slug}
        viewTransitionName={`x-agent-${target.slug}`}
        iconFallback="blocks"
        name={target.name}
        subtitle={
          connected ? (
            <span className="truncate">
              Read: {decisionLabel(getDecision('read', target.slug))} · Send:{' '}
              {decisionLabel(getDecision('invoke', target.slug))}
            </span>
          ) : (
            <span className="truncate font-mono">{target.slug}</span>
          )
        }
        right={
          <>
            {connected && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => openPermissionDialog(target)}
                data-testid={`x-agent-policy-edit-${target.slug}`}
                aria-label={`Edit ${target.name} permissions`}
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            )}
            {isSavingRow ? (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="Saving access change"
                data-testid={`x-agent-policy-switch-${target.slug}-pending`}
              />
            ) : (
              <Switch
                checked={connected}
                onCheckedChange={(next) => handleToggleTarget(target, next)}
                data-testid={`x-agent-policy-switch-${target.slug}`}
                aria-label={`${connected ? 'Disconnect' : 'Connect'} ${target.name}`}
              />
            )}
          </>
        }
      />
    )
  }

  const handleChange = (operation: Operation, targetSlug: string | null) => (next: DecisionOrDefault) => {
    savePolicies.mutate({ operation, targetSlug, decision: next })
  }

  return (
    <SettingsPageContainer>
      <PageTitle
        title="Connect to other agents"
        back={{
          onClick: () => setView({ kind: 'home' }),
          testId: 'connected-agents-back-button',
        }}
      />

      {policiesQuery.isLoading || agentsQuery.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {/* Workspace-wide controls */}
          <div className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">
            <div
              className="flex items-center justify-between gap-3 px-4 py-3"
              data-testid="x-agent-policy-global-list"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">List all agents</div>
                <p className="text-[11px] text-muted-foreground">
                  Whether this agent can discover the other agents in this workspace.
                </p>
              </div>
              <PolicyDecisionToggle value={getDecision('list', null)} onChange={handleChange('list', null)} />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">Connect to all agents</div>
                <p className="text-[11px] text-muted-foreground">
                  Connect (Allow read &amp; send) or disconnect every agent below at once.
                </p>
              </div>
              {saveAllAgents.isPending ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-muted-foreground"
                  aria-label="Saving access change"
                  data-testid="x-agent-policy-connect-all-pending"
                />
              ) : (
                <Switch
                  checked={allAgentsConnected}
                  disabled={otherAgents.length === 0}
                  onCheckedChange={handleToggleAllAgents}
                  data-testid="x-agent-policy-connect-all"
                  aria-label={`${allAgentsConnected ? 'Disconnect' : 'Connect to'} all agents`}
                />
              )}
            </div>
          </div>

          {otherAgents.length === 0 ? (
            <p className="pt-4 text-sm text-muted-foreground">
              No other agents in this workspace yet.
            </p>
          ) : (
            <div className="space-y-6 pt-4">
              <AccessSection label="Connected">
                {connectedAgents.length > 0 ? (
                  <IntegrationList>{connectedAgents.map(renderTargetRow)}</IntegrationList>
                ) : (
                  <div className="rounded-xl border border-dashed bg-background px-4 py-6 text-center">
                    <p className="text-xs text-muted-foreground">
                      Not connected to any agents yet. Toggle one on below.
                    </p>
                  </div>
                )}
              </AccessSection>
              {notConnectedAgents.length > 0 && (
                <AccessSection label="Not connected">
                  <IntegrationList>{notConnectedAgents.map(renderTargetRow)}</IntegrationList>
                </AccessSection>
              )}
            </div>
          )}
        </div>
      )}

      <Dialog open={!!dialogTarget} onOpenChange={(open) => { if (!open) setDialogTarget(null) }}>
        <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>
              {dialogTarget ? `Connect ${dialogTarget.name}` : 'Connect agent'}
            </DialogTitle>
            <DialogDescription>
              Choose what this agent may do with{' '}
              <span className="font-medium">{dialogTarget?.name}</span>. Read and Send are
              independent — <span className="font-medium">Allow</span> skips the prompt,{' '}
              <span className="font-medium">Review</span> prompts every time,{' '}
              <span className="font-medium">Block</span> denies without prompting.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">Read sessions</div>
                <p className="text-[11px] text-muted-foreground">Browse this agent&apos;s sessions and transcripts.</p>
              </div>
              <PolicyDecisionToggle value={draftRead} onChange={setDraftRead} />
            </div>
            <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">Send messages</div>
                <p className="text-[11px] text-muted-foreground">Trigger this agent and send it messages.</p>
              </div>
              <PolicyDecisionToggle value={draftInvoke} onChange={setDraftInvoke} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveDialog} disabled={saveTargetPolicies.isPending}>
              {saveTargetPolicies.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageContainer>
  )
}

/** Labelled group of rows — mirrors the "Access granted / not granted" pattern. */
function AccessSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wider font-medium text-muted-foreground px-1">
        {label}
      </p>
      {children}
    </div>
  )
}
