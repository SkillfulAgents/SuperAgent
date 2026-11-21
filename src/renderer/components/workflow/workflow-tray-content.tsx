import { useEffect, useMemo, useRef } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { WorkflowIcon } from './workflow-icon'
import { cn } from '@shared/lib/utils/cn'
import { useWorkflow } from '@renderer/context/workflow-context'
import { useMessageStream, type WorkflowAgentLive } from '@renderer/hooks/use-message-stream'
import { useWorkflowTree, useWorkflowAgentMessages } from '@renderer/hooks/use-messages'
import { StatusIndicator } from '@renderer/components/messages/tool-call-item'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import { formatModelId } from '@renderer/lib/model-label'
import { WorkflowAgentTranscript } from './workflow-agent-transcript'
import { TRAY_BODY_CLASS } from '@renderer/components/tray/tray-card'
import type { WorkflowAgentNode } from '@shared/lib/workflows/workflow-schemas'

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

/** Compact "12s · 3 tools · 1.2k tokens" line; omits empty parts. */
export function StatsLine({
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
  runId: string
  /** The one agent of the run to show in place of the run's own list. */
  agentId?: string
  /** The name the run was opened with, until the run's own is known. */
  fallbackName?: string
}

interface PhaseGroup {
  title: string | null
  detail?: string
  agents: MergedAgentNode[]
}

/**
 * Merge live agents with the disk tree. Live progress must be renderable before
 * the disk reconstruction finishes (or if it fails).
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
  const knownIds = new Set(base.map((a) => a.agentId))
  const merged: MergedAgentNode[] = base.map((a) => {
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
      // The wire label is the one the script actually passed to agent(); the disk
      // label is a heuristic re-join of prompt ↔ call site that degrades to "agent N"
      // when a label variable can't be recovered from the prompt text. Prefer the
      // wire while it's flowing; disk covers reloads of finished runs.
      label: live.label ?? a.label,
      phase: live.phase ?? a.phase,
      model: live.model ?? a.model,
      prompt: a.prompt || live.prompt || '',
      // Live tokens/tools are fresher than disk reconciliation; disk covers reloads.
      tokens: live.tokens ?? a.tokens,
      toolCount: live.toolCount ?? a.toolCount,
      lastTool: live.lastTool ?? null,
    }
  })
  for (const [agentId, live] of Object.entries(liveAgents)) {
    if (knownIds.has(agentId)) continue
    merged.push({
      agentId,
      label: live.label ?? `agent ${merged.length + 1}`,
      phase: live.phase ?? null,
      status: live.status,
      result: live.result,
      resolved: 'unresolved',
      prompt: live.prompt ?? '',
      model: live.model ?? null,
      tokens: live.tokens ?? 0,
      toolCount: live.toolCount ?? 0,
      durationMs: null,
      lastTool: live.lastTool ?? null,
    })
  }
  return merged
}

/**
 * Distinct model labels across a phase's agents, in first-seen order — the
 * phase header shows "Haiku 4.5" for a uniform fan-out, or "Haiku 4.5 · Sonnet 5"
 * when a phase mixes models (e.g. a cheap pass plus a critic).
 */
export function phaseModels(agents: Pick<WorkflowAgentNode, 'model'>[]): string[] {
  const seen = new Set<string>()
  for (const a of agents) {
    if (a.model) seen.add(formatModelId(a.model))
  }
  return [...seen]
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
    <div className="px-4 pt-1 pb-2 shrink-0">
      <div className="flex items-center gap-1">
        {segments.map((s, i) => (
          <div key={i} className={cn('h-1.5 flex-1 rounded-full transition-colors', SEGMENT_CLASS[s])} />
        ))}
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">{progressSummary(segments)}</div>
    </div>
  )
}

/**
 * One run as the drawer shows it: the disk tree with live status laid over it.
 * Shared by the run's own tab and by the tab of any one of its agents.
 */
export function useWorkflowRun(sessionId: string, agentSlug: string, runId: string) {
  const { workflows } = useMessageStream(sessionId, agentSlug, ['workflows'])

  const liveRun = workflows.find((w) => w.runId === runId)
  const isActive = !!liveRun && liveRun.completedAt === undefined
  const hasLiveAgents = !!liveRun && Object.keys(liveRun.agents).length > 0
  const treeQuery = useWorkflowTree(sessionId, agentSlug, runId, {
    active: isActive,
    hasLiveAgents,
  })

  // Disk enriches the live preview and covers reloads; it never gates live rows.
  const agents = useMemo<MergedAgentNode[]>(
    () => overlayLiveStatus(treeQuery.data?.agents ?? [], liveRun?.agents),
    [treeQuery.data, liveRun]
  )

  // Per-agent transitions already carry what the preview needs. Reconstructing
  // every transcript on each transition makes a wide fan-out flood the host.
  // Reconcile periodically and once on completion for durable final results.
  const completedAt = liveRun?.completedAt
  const refetchTree = treeQuery.refetch
  const isFetchingTree = treeQuery.isFetching
  const reconciledCompletion = useRef<string | null>(null)
  const sawActiveRun = useRef<string | null>(null)
  useEffect(() => {
    if (completedAt === undefined) {
      if (liveRun) sawActiveRun.current = runId
      return
    }
    if (isFetchingTree) return
    const key = `${runId}:${completedAt}`
    if (reconciledCompletion.current === key) return
    reconciledCompletion.current = key
    // Opened on an already-finished run: the mount fetch is already final.
    if (sawActiveRun.current !== runId) return
    // Wait out any pre-completion request, then fetch a fresh snapshot. Simply
    // refetching during the initial load reuses that older in-flight request.
    refetchTree({ cancelRefetch: false })
  }, [completedAt, runId, refetchTree, isFetchingTree, liveRun])

  return { liveRun, isActive, treeQuery, agents }
}

/**
 * A workflow run's tab: its progress, then one row per agent. Picking a row
 * shows that agent's transcript in place, with a way back to the run.
 */
export function WorkflowTrayContent({ agentSlug, sessionId, runId, agentId, fallbackName }: WorkflowTrayContentProps) {
  const { viewWorkflowAgent } = useWorkflow()
  const { liveRun, isActive, treeQuery, agents } = useWorkflowRun(sessionId, agentSlug, runId)

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

  // The script's own meta.name is authoritative; the name the tab was opened with is
  // whatever the launching card had (for a scriptPath run, only a generic fallback).
  const name = treeQuery.data?.name ?? fallbackName ?? 'Workflow'
  // Prefer the live wire usage (cumulative, accurate); fall back to the disk rollup.
  const totals = liveRun?.usage
    ? { durationMs: liveRun.usage.durationMs, toolCount: liveRun.usage.toolUses, tokens: liveRun.usage.totalTokens }
    : treeQuery.data?.totals ?? null
  const noAgentsYet =
    !treeQuery.isLoading && !treeQuery.isError && !!treeQuery.data && groups.every((g) => g.agents.length === 0)
  const viewed = agentId ? agents.find((a) => a.agentId === agentId) : undefined

  return (
    // The drawer's card holds it like a file or a page, so the run reads as one more tab.
    <div className={TRAY_BODY_CLASS} data-testid="workflow-tray">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {agentId ? (
          <WorkflowAgentDetail
            key={agentId}
            agent={viewed}
            agentId={agentId}
            runId={runId}
            runName={name}
            loading={treeQuery.isLoading}
            sessionId={sessionId}
            agentSlug={agentSlug}
            onBack={() => viewWorkflowAgent(runId, null)}
          />
        ) : (<>
        <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
          <WorkflowIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</h2>
          {totals && (
            <StatsLine
              className="shrink-0"
              durationMs={totals.durationMs}
              toolCount={totals.toolCount}
              tokens={totals.tokens}
            />
          )}
        </div>

        <WorkflowProgressBar agents={agents} expectedAgents={treeQuery.data?.expectedAgents ?? 0} active={isActive} />

        <div className="flex-1 min-h-0 overflow-auto px-3 pb-3 space-y-4">
          {treeQuery.isLoading && agents.length === 0 && (
            <div className="text-xs text-muted-foreground italic px-1">Loading workflow…</div>
          )}
          {treeQuery.isError && isActive && (
            <div className="text-xs text-muted-foreground italic px-1">
              {agents.length > 0
                ? 'Some workflow details are unavailable. Retrying…'
                : 'Workflow is running. Retrying details…'}
            </div>
          )}
          {treeQuery.isError && !isActive && (
            <div className="text-xs text-destructive px-1">Couldn&apos;t load this workflow.</div>
          )}
          {treeQuery.data?.description && (
            <p className="text-xs text-muted-foreground px-1">{treeQuery.data.description}</p>
          )}

          {groups.map((group, gi) => (
            <div key={group.title ?? `__ungrouped-${gi}`} className="space-y-1.5" data-testid="workflow-phase-group" data-phase={group.title ?? undefined}>
              {group.title && (
                <div className="flex items-baseline gap-2 px-1">
                  <span className="text-xs font-medium text-foreground/80">{group.title}</span>
                  {group.detail && (
                    <span className="text-[11px] text-muted-foreground truncate">{group.detail}</span>
                  )}
                  {phaseModels(group.agents).length > 0 && (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70 whitespace-nowrap">
                      {phaseModels(group.agents).join(' · ')}
                    </span>
                  )}
                </div>
              )}
              {group.agents.map((a) => (
                <WorkflowAgentRow
                  key={a.agentId}
                  agent={a}
                  onOpen={() => viewWorkflowAgent(runId, a.agentId)}
                />
              ))}
            </div>
          ))}

          {noAgentsYet && <div className="text-xs text-muted-foreground italic px-1">No agents have started yet.</div>}
        </div>
        </>)}
      </div>
    </div>
  )
}

/** One agent of the run. The row says where it is; picking it shows its transcript in the run's tab. */
function WorkflowAgentRow({ agent, onOpen }: { agent: MergedAgentNode; onOpen: () => void }) {
  const isRunning = agent.status === 'running'
  const indicatorStatus =
    agent.status === 'done' ? 'completed' : agent.status === 'failed' ? 'error' : 'running'

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="workflow-agent-row"
      data-agent-label={agent.label}
      title="Open this agent's transcript"
      className="flex w-full items-center gap-2 rounded-card border border-border/70 px-2 py-1.5 text-left group hover:bg-muted/50 transition-colors"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <StatusIndicator status={indicatorStatus} />
      </span>
      {/* shrink-0 + cap: a long result/tool string must truncate itself, not crush the label to zero width */}
      <span className="text-xs text-foreground/80 truncate shrink-0 max-w-[70%]">{agent.label}</span>
      {agent.model && (
        <span
          className="shrink-0 rounded px-1 py-px text-[10px] leading-tight bg-muted text-muted-foreground/80"
          title={agent.model}
        >
          {formatModelId(agent.model)}
        </span>
      )}
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
      <span className="ml-auto shrink-0 text-muted-foreground/60 group-hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  )
}

/** One agent of a run, read closely: its task, its transcript and what it returned, with the way back to the run. */
function WorkflowAgentDetail({
  agent,
  agentId,
  runId,
  runName,
  loading,
  sessionId,
  agentSlug,
  onBack,
}: {
  /** Absent until the run's tree or the live stream names this agent. */
  agent: MergedAgentNode | undefined
  agentId: string
  runId: string
  runName: string
  loading: boolean
  sessionId: string
  agentSlug: string
  onBack: () => void
}) {
  const isRunning = agent?.status === 'running'
  const messages = useWorkflowAgentMessages(sessionId, agentSlug, runId, agentId, { isRunning })
  const finished = agent?.status === 'done' || agent?.status === 'failed'

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-testid="workflow-agent-transcript" data-status={agent?.status}>
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex shrink-0 rounded-icon p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Back to ${runName}`}
          title={`Back to ${runName}`}
          data-testid="workflow-agent-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{agent?.label ?? 'Agent'}</h2>
        {agent?.phase && <span className="shrink-0 truncate text-xs text-muted-foreground">{agent.phase}</span>}
        {agent?.model && (
          <span
            className="shrink-0 rounded px-1 py-px text-[10px] leading-tight bg-muted text-muted-foreground/80"
            title={agent.model}
          >
            {formatModelId(agent.model)}
          </span>
        )}
        {agent && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <StatusIndicator status={agent.status === 'done' ? 'completed' : agent.status === 'failed' ? 'error' : 'running'} />
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 pb-4">
        {agent?.prompt && (
          <div className="rounded-item bg-muted/50 px-3 py-2 text-xs" data-testid="workflow-agent-task">
            <div className="mb-1 text-2xs text-muted-foreground/70">Task</div>
            <div className="whitespace-pre-wrap break-words text-foreground/80">{agent.prompt}</div>
          </div>
        )}
        {!agent && loading && <div className="text-xs text-muted-foreground italic">Loading agent…</div>}
        <WorkflowAgentTranscript messages={messages.data} agentSlug={agentSlug} isRunning={isRunning} />
        {finished && agent?.result && (
          <div className="rounded-item bg-muted/50 px-3 py-2 text-xs" data-testid="workflow-agent-result">
            <div className="mb-1 text-2xs text-muted-foreground/70">{agent.status === 'failed' ? 'Error' : 'Result'}</div>
            <div className={cn('whitespace-pre-wrap break-words', agent.status === 'failed' ? 'text-destructive' : 'text-foreground/80')}>
              {agent.result}
            </div>
          </div>
        )}
      </div>

      {agent && (
        <div className="shrink-0 border-t border-border/40 px-4 py-2">
          <StatsLine durationMs={agent.durationMs} toolCount={agent.toolCount} tokens={agent.tokens} className="text-xs" />
        </div>
      )}
    </div>
  )
}
