import { Workflow } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { StatusIndicator } from './tool-call-item'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import type { ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

/**
 * Tier-0 status block for a dynamic-workflow (`Workflow` tool) run.
 *
 * A workflow runs as a background fan-out of subagents inside the CLI; only
 * WORKFLOW-LEVEL lifecycle crosses the SDK stream (the per-agent transcripts
 * live on disk, not on the wire — a full per-agent drawer is a planned follow-up).
 * The persister maps the workflow's `task_*` events onto the existing subagent
 * channel keyed by the Workflow tool's `tool_use_id`, so we can show a live
 * running→done status, cumulative usage, and the currently-active agent label
 * (`lastToolName`) with no extra plumbing. The Workflow tool itself returns an
 * immediate `async_launched` result, so WITHOUT this block it renders as a
 * generic tool call that looks "done" a second after launch — misleading while
 * the workflow is still running.
 */

const LABEL_CLASS =
  'font-sans font-normal shrink-0 text-sm text-foreground/65 group-hover:text-foreground leading-none transition-colors'

type WorkflowStatus = 'running' | 'completed' | 'error'

interface WorkflowBlockProps {
  toolCall: ApiToolCall
  activeSubagent?: SubagentInfo | null
  isCompleted?: boolean // subagent_completed SSE fired for this tool
  // NOTE: intentionally no `isSessionActive` (unlike SubAgentBlock). A workflow is a
  // background task that outlives its launch turn, so its running state is driven by
  // its own subagent lifecycle — see the status comment below.
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

/** Best-effort `meta.name` from the workflow script (input.script) — used only as a fallback label. */
function parseWorkflowName(toolCall: ApiToolCall): string | null {
  const input = toolCall.input as { script?: string; name?: string } | undefined
  if (input?.name) return input.name
  if (typeof input?.script === 'string') {
    const m = input.script.match(/name\s*:\s*['"]([^'"]+)['"]/)
    if (m) return m[1]
  }
  return null
}

export function WorkflowBlock({
  toolCall,
  activeSubagent,
  isCompleted,
}: WorkflowBlockProps) {
  const isActive = activeSubagent?.parentToolId === toolCall.id

  // A workflow is a BACKGROUND task that outlives the turn: the agent launches it
  // (async_launched) and goes idle while it keeps running. So "running" is driven by
  // the workflow's own lifecycle — its subagent state is still tracked and not yet
  // completed — NOT by isSessionActive (which flips false the moment the launch turn
  // ends, even though task_progress/subagent_completed keep flowing afterward).
  let status: WorkflowStatus = 'completed'
  if (isCompleted) {
    status = toolCall.isError ? 'error' : 'completed'
  } else if (isActive) {
    status = 'running'
  } else if (toolCall.isError) {
    status = 'error'
  }
  const isRunning = status === 'running'

  // Label: prefer the live workflow description (forwarded on subagent_started),
  // fall back to the script's meta.name, then a generic label.
  const label = activeSubagent?.description || parseWorkflowName(toolCall) || 'workflow'

  // While running, lastToolName carries the currently-active agent label
  // (from task_progress.last_tool_name, e.g. "word-beta" / "concat").
  const currentAgent = isRunning && isActive ? activeSubagent?.lastToolName : null
  const usage = isActive ? activeSubagent?.usage : null

  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden">
      <div className="flex w-full items-center gap-2 pl-2 pr-2 py-1.5 group">
        <Workflow className="h-3.5 w-3.5 shrink-0 text-foreground/45" />
        <span className={LABEL_CLASS}>Workflow:</span>
        <span className="text-muted-foreground/80 truncate text-xs leading-none">{label}</span>
        {currentAgent && (
          <>
            <span aria-hidden className="shrink-0 text-foreground/40 text-sm leading-none">→</span>
            <span className="text-muted-foreground/70 truncate text-xs leading-none font-mono">
              {currentAgent}
            </span>
          </>
        )}
        <span className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center">
          <StatusIndicator status={status} />
        </span>
      </div>
      {isRunning && usage && (usage.total_tokens > 0 || usage.duration_ms > 0) && (
        <div className={cn('border-t border-border/70 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground italic')}>
          {formatElapsed(usage.duration_ms)}
          {' · '}{formatTokens(usage.total_tokens)} tokens
        </div>
      )}
    </div>
  )
}
