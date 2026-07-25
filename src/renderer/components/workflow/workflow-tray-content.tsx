import { useEffect, useMemo } from 'react'
import { Workflow as WorkflowIcon, PanelRightClose, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useWorkflow } from '@renderer/context/workflow-context'
import { useMessageStream, type WorkflowAgentLive } from '@renderer/hooks/use-message-stream'
import { useWorkflowTree, useWorkflowAgentMessages } from '@renderer/hooks/use-messages'
import { StatusIndicator } from '@renderer/components/messages/tool-call-item'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import { WorkflowAgentTranscript } from './workflow-agent-transcript'
import type { WorkflowAgentNode } from '@shared/lib/workflows/workflow-schemas'

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

/** Compact "12s · 3 tools · 1.2k tokens" line; omits empty parts. */
function StatsLine({
  durationMs,
  toolCount,
  tokens,
  className,
}: {
  durationMs: number | null
  toolCount: number
  tokens: number
  className?: string
}) {
  const parts: string[] = []
  if (durationMs != null && durationMs > 0) parts.push(formatElapsed(durationMs))
  if (toolCount > 0) parts.push(`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`)
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`)
  if (parts.length === 0) return null
  return <div className={cn('text-[11px] text-muted-foreground', className)}>{parts.join(' · ')}</div>
}

interface WorkflowTrayContentProps {
  agentSlug: string
  sessionId: string
  onClose: () => void
}

interface PhaseGroup {
  title: string | null
  detail?: string
  agents: MergedAgentNode[]
}

/**
 * Overlay the live SSE per-agent status (from the journal tailer) onto the disk tree.
 * `done` is terminal: a stale live `running` must NEVER override a tree `done` (the tailer
 * can miss the very last `result` line when completion races the poll), and vice versa.
 * Disk is the source of truth for the result string.
 */
/** A tree node enriched with live-only fields (the current tool an agent is running). */
export type MergedAgentNode = WorkflowAgentNode & { lastTool?: string | null }

export function overlayLiveStatus(
  base: WorkflowAgentNode[],
  liveAgents: Record<string, WorkflowAgentLive> | undefined
): MergedAgentNode[] {
  if (!liveAgents) return base
  return base.map((a) => {
    const live = liveAgents[a.agentId]
    if (!live) return a
    // `done` from either source wins (a result on disk or wire is definitive), then
    // `failed` from either (the tree detects it durably from a trailing transcript
    // error frame); a stale `running` on one side never downgrades the other.
    const status: WorkflowAgentNode['status'] =
      a.status === 'done' || live.status === 'done'
        ? 'done'
        : a.status === 'failed' || live.status === 'failed'
          ? 'failed'
          : 'running'
    return {
      ...a,
      status,
      result: a.result ?? live.result ?? null,
      // Live tokens/tools are fresher than the ~2s disk poll; fall back to disk on reload.
      tokens: live.tokens ?? a.tokens,
      toolCount: live.toolCount ?? a.toolCount,
      lastTool: live.lastTool ?? null,
    }
  })
}

export type ProgressSegment = 'done' | 'running' | 'failed' | 'pending'

/**
 * One progress cell per agent: known agents colored by status, plus gray "pending"
 * cells for expected-but-not-yet-started agents (`expectedAgents` sizes `args`
 * fan-outs from the invocation but is still a lower bound — a runtime fan-out just
 * grows the bar, never shows phantom pending). A finished run (`active` false)
 * never shows pending: whatever didn't start by then never will.
 */
export function workflowProgressSegments(
  agents: Pick<WorkflowAgentNode, 'status'>[],
  expectedAgents: number,
  active = true
): ProgressSegment[] {
  const segs: ProgressSegment[] = agents.map((a) =>
    a.status === 'done' ? 'done' : a.status === 'failed' ? 'failed' : 'running'
  )
  const pending = active ? Math.max(0, expectedAgents - agents.length) : 0
  for (let i = 0; i < pending; i++) segs.push('pending')
  return segs
}

/**
 * Summary line under the bar. Failed agents are FINISHED — counting only green
 * would read "22/24" with 23 over ("22 done, 1 failed"), so the numerator counts
 * both and failures get called out explicitly.
 */
export function progressSummary(segments: ProgressSegment[]): string {
  const done = segments.filter((s) => s === 'done').length
  const failed = segments.filter((s) => s === 'failed').length
  if (failed === 0) return `${done}/${segments.length} agents done`
  return `${done + failed}/${segments.length} agents finished · ${failed} failed`
}

const SEGMENT_CLASS: Record<ProgressSegment, string> = {
  done: 'bg-emerald-500',
  running: 'bg-blue-500 animate-pulse',
  failed: 'bg-red-500',
  pending: 'bg-muted-foreground/20',
}

function WorkflowProgressBar({
  agents,
  expectedAgents,
  active,
}: {
  agents: WorkflowAgentNode[]
  expectedAgents: number
  active: boolean
}) {
  const segments = workflowProgressSegments(agents, expectedAgents, active)
  if (segments.length === 0) return null
  return (
    <div className="px-4 pt-2.5 pb-2 shrink-0">
      <div className="flex items-center gap-1">
        {segments.map((s, i) => (
          <div key={i} className={cn('h-1.5 flex-1 rounded-full transition-colors', SEGMENT_CLASS[s])} />
        ))}
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">{progressSummary(segments)}</div>
    </div>
  )
}

export function WorkflowTrayContent({ agentSlug, sessionId, onClose }: WorkflowTrayContentProps) {
  const { openWorkflows, selectedRunId, selectWorkflow, expandedAgentId, setExpandedAgent } = useWorkflow()
  const { workflows } = useMessageStream(sessionId, agentSlug)

  const liveRun = workflows.find((w) => w.runId === selectedRunId)
  const isActive = !!liveRun && liveRun.completedAt === undefined
  const treeQuery = useWorkflowTree(sessionId, agentSlug, selectedRunId, { active: isActive })

  // Disk tree is the source of truth (survives reload); overlay live SSE status.
  const agents = useMemo<MergedAgentNode[]>(
    () => overlayLiveStatus(treeQuery.data?.agents ?? [], liveRun?.agents),
    [treeQuery.data, liveRun]
  )

  // When a live transition arrives (new agent started / result / completion), refetch
  // the disk tree to pick up freshly-resolved labels + final results.
  const liveSignal = liveRun
    ? `${Object.entries(liveRun.agents)
        .map(([k, v]) => `${k}:${v.status}`)
        .sort()
        .join(',')}|${liveRun.completedAt ?? ''}`
    : ''
  const refetchTree = treeQuery.refetch
  useEffect(() => {
    if (selectedRunId && liveSignal) refetchTree()
  }, [liveSignal, selectedRunId, refetchTree])

  const groups = useMemo<PhaseGroup[]>(() => {
    const phaseOrder = treeQuery.data?.phases ?? []
    const byPhase = new Map<string, MergedAgentNode[]>()
    const ungrouped: MergedAgentNode[] = []
    for (const a of agents) {
      if (a.phase) {
        const list = byPhase.get(a.phase) ?? []
        list.push(a)
        byPhase.set(a.phase, list)
      } else {
        ungrouped.push(a)
      }
    }
    const ordered: PhaseGroup[] = []
    for (const p of phaseOrder) {
      ordered.push({ title: p.title, detail: p.detail, agents: byPhase.get(p.title) ?? [] })
      byPhase.delete(p.title)
    }
    // Phases referenced via opts.phase but not declared in meta.phases.
    for (const [title, list] of byPhase) ordered.push({ title, agents: list })
    if (ungrouped.length) ordered.push({ title: null, agents: ungrouped })
    return ordered
  }, [agents, treeQuery.data])

  const name = openWorkflows.find((w) => w.runId === selectedRunId)?.name ?? treeQuery.data?.name ?? 'Workflow'
  // Prefer the live wire usage (cumulative, accurate); fall back to the disk rollup.
  const totals = liveRun?.usage
    ? { durationMs: liveRun.usage.durationMs, toolCount: liveRun.usage.toolUses, tokens: liveRun.usage.totalTokens }
    : treeQuery.data?.totals ?? null
  const noAgentsYet =
    !treeQuery.isLoading && !treeQuery.isError && !!treeQuery.data && groups.every((g) => g.agents.length === 0)

  if (!selectedRunId) return null

  return (
    <div className="contents" data-testid="workflow-tray">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground select-none shrink-0 border-b border-border/40">
        <WorkflowIcon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-xs truncate font-medium">{name}</span>
        <button
          className="p-0.5 rounded hover:bg-muted transition-colors"
          onClick={onClose}
          title="Hide workflow panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <WorkflowProgressBar agents={agents} expectedAgents={treeQuery.data?.expectedAgents ?? 0} active={isActive} />

      {openWorkflows.length > 1 && (
        <div className="px-4 pb-2 shrink-0">
          <select
            value={selectedRunId}
            onChange={(e) => selectWorkflow(e.target.value)}
            className="w-full text-xs rounded border border-border bg-background px-2 py-1"
          >
            {openWorkflows.map((w) => (
              <option key={w.runId} value={w.runId}>
                {w.name ?? w.runId}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3 space-y-4">
        {treeQuery.isLoading && <div className="text-xs text-muted-foreground italic px-1">Loading workflow…</div>}
        {/* Right after launch the on-disk dir doesn't exist yet → the route 404s. While the
            run is active that's "starting", not a failure (the poll will pick it up). */}
        {treeQuery.isError && isActive && (
          <div className="text-xs text-muted-foreground italic px-1">Starting workflow…</div>
        )}
        {treeQuery.isError && !isActive && (
          <div className="text-xs text-destructive px-1">Couldn&apos;t load this workflow.</div>
        )}
        {treeQuery.data?.description && (
          <p className="text-xs text-muted-foreground px-1">{treeQuery.data.description}</p>
        )}
        {totals && (
          <StatsLine
            className="px-1"
            durationMs={totals.durationMs}
            toolCount={totals.toolCount}
            tokens={totals.tokens}
          />
        )}

        {groups.map((group, gi) => (
          <div key={group.title ?? `__ungrouped-${gi}`} className="space-y-1.5">
            {group.title && (
              <div className="flex items-baseline gap-2 px-1">
                <span className="text-xs font-medium text-foreground/80">{group.title}</span>
                {group.detail && (
                  <span className="text-[11px] text-muted-foreground truncate">{group.detail}</span>
                )}
              </div>
            )}
            {group.agents.map((a) => (
              <WorkflowAgentRow
                key={a.agentId}
                agent={a}
                expanded={expandedAgentId === a.agentId}
                onToggle={() => setExpandedAgent(expandedAgentId === a.agentId ? null : a.agentId)}
                sessionId={sessionId}
                agentSlug={agentSlug}
                runId={selectedRunId}
              />
            ))}
          </div>
        ))}

        {noAgentsYet && <div className="text-xs text-muted-foreground italic px-1">No agents have started yet.</div>}
      </div>
    </div>
  )
}

function WorkflowAgentRow({
  agent,
  expanded,
  onToggle,
  sessionId,
  agentSlug,
  runId,
}: {
  agent: MergedAgentNode
  expanded: boolean
  onToggle: () => void
  sessionId: string
  agentSlug: string
  runId: string
}) {
  const isRunning = agent.status === 'running'
  const indicatorStatus =
    agent.status === 'done' ? 'completed' : agent.status === 'failed' ? 'error' : 'running'
  // Only the expanded row fetches (and only polls while still running).
  const messages = useWorkflowAgentMessages(sessionId, agentSlug, runId, expanded ? agent.agentId : null, {
    isRunning,
  })

  return (
    <div className="border border-border/70 rounded-md overflow-hidden">
      <button
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1.5 group hover:bg-muted/50 transition-colors',
          expanded && 'bg-muted/50'
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <StatusIndicator status={indicatorStatus} />
        </span>
        {/* shrink-0 + cap: a long result/tool string must truncate itself, not crush the label to zero width */}
        <span className="text-xs text-foreground/80 truncate shrink-0 max-w-[70%]">{agent.label}</span>
        {/* While running, show the current tool (live from the wire). */}
        {isRunning && agent.lastTool && (
          <>
            <span aria-hidden className="shrink-0 text-foreground/40 text-xs leading-none">→</span>
            <span className="text-[11px] text-muted-foreground/70 truncate min-w-0 font-mono">{agent.lastTool}</span>
          </>
        )}
        {/* Terminal agents show their return value — or, for failed ones, the error. */}
        {(agent.status === 'done' || agent.status === 'failed') && agent.result && (
          <span
            className={cn(
              'text-[11px] truncate min-w-0',
              agent.status === 'failed' ? 'text-destructive/80' : 'text-muted-foreground/80'
            )}
          >
            {agent.result}
          </span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground/60">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border/70 bg-muted/40 px-3 py-3 space-y-3">
          {agent.prompt && (
            <div className="text-[11px] text-muted-foreground break-words">
              <span className="font-medium text-foreground/70">Task: </span>
              {agent.prompt}
            </div>
          )}
          <StatsLine durationMs={agent.durationMs} toolCount={agent.toolCount} tokens={agent.tokens} />
          {(agent.status === 'done' || agent.status === 'failed') && agent.result && (
            <div className="text-[11px] break-words">
              <span className="font-medium text-foreground/70">
                {agent.status === 'failed' ? 'Error: ' : 'Result: '}
              </span>
              <span className={agent.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                {agent.result}
              </span>
            </div>
          )}
          <WorkflowAgentTranscript messages={messages.data} agentSlug={agentSlug} isRunning={isRunning} />
        </div>
      )}
    </div>
  )
}
