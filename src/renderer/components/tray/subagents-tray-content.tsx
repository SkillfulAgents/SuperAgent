import { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { TRAY_BODY_CLASS } from './tray-card'
import { useWorkflow } from '@renderer/context/workflow-context'
import { useMessageStream, type SubagentInfo } from '@renderer/hooks/use-message-stream'
import { useMessages } from '@renderer/hooks/use-messages'
import { SubagentTranscript, displaySubagentType, subagentStatus, type SubagentStatus } from '@renderer/components/messages/subagent-block'
import { resolveSubagentRun } from '@renderer/components/messages/subagent-run'
import { SubagentAvatar } from '@renderer/components/agents/agent-avatar/subagent-avatar'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import type { ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'

interface SubagentsTrayContentProps {
  agentSlug: string
  sessionId: string
}

interface SubagentEntry {
  toolCall: ApiToolCall
  activeSubagent: SubagentInfo | null
  isCompleted: boolean
  status: SubagentStatus
}

/** The Agent calls in the loaded transcript, oldest first: one per subagent the session launched. */
export function subagentCalls(messages: ApiMessageOrBoundary[] | undefined): ApiToolCall[] {
  const calls: ApiToolCall[] = []
  for (const message of messages ?? []) {
    if (message.type !== 'assistant') continue
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.name === 'Task' || toolCall.name === 'Agent') calls.push(toolCall)
    }
  }
  return calls
}

function subagentName(toolCall: ApiToolCall, activeSubagent: SubagentInfo | null): string {
  const input = toolCall.input as { subagent_type?: string; description?: string }
  return activeSubagent?.description || input.description || displaySubagentType(activeSubagent?.subagentType || input.subagent_type || 'Agent')
}

/**
 * The drawer's Subagents tab. It opens on every subagent of the session, the
 * working ones first, and picking one shows its transcript in place with a way
 * back. One tab however many subagents there are, so they never crowd the strip.
 */
export function SubagentsTrayContent({ agentSlug, sessionId }: SubagentsTrayContentProps) {
  const { subagents, viewSubagent } = useWorkflow()
  const { activeSubagents, completedSubagents, isActive } = useMessageStream(
    sessionId, agentSlug, ['activeSubagents', 'completedSubagents', 'isActive'],
  )
  const { data: messages } = useMessages(sessionId, agentSlug)

  const entries = useMemo<SubagentEntry[]>(() => {
    const calls = subagentCalls(messages)
    // The subagent being viewed may have been opened before the transcript saved its call.
    const viewing = subagents.viewing
    if (viewing && !calls.some(call => call.id === viewing.id)) calls.push(viewing)
    return calls.map((toolCall) => {
      const run = resolveSubagentRun(toolCall, activeSubagents, completedSubagents)
      return {
        toolCall,
        activeSubagent: run.activeSubagent,
        isCompleted: run.isCompleted,
        status: subagentStatus({ toolCall, isSessionActive: isActive, activeSubagent: run.activeSubagent, isCompleted: run.isCompleted }),
      }
    })
  }, [messages, subagents.viewing, activeSubagents, completedSubagents, isActive])

  const viewed = subagents.viewing ? entries.find(entry => entry.toolCall.id === subagents.viewing?.id) : undefined
  const active = entries.filter(entry => entry.status === 'running')
  // The one that finished last is the one most likely wanted, so it leads.
  const done = entries.filter(entry => entry.status !== 'running').reverse()

  return (
    <div className={TRAY_BODY_CLASS} data-testid="subagents-tray">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {viewed ? (
          <SubagentTranscript
            key={viewed.toolCall.id}
            toolCall={viewed.toolCall}
            sessionId={sessionId}
            agentSlug={agentSlug}
            isSessionActive={isActive}
            activeSubagent={viewed.activeSubagent}
            isCompleted={viewed.isCompleted}
            onBack={() => viewSubagent(null)}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-2 py-3" data-testid="subagents-list">
            {entries.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground italic">No subagents in this session yet.</div>
            )}
            <SubagentGroup title="Active" entries={active} onPick={viewSubagent} />
            <SubagentGroup title="Done" entries={done} onPick={viewSubagent} />
          </div>
        )}
      </div>
    </div>
  )
}

function SubagentGroup({ title, entries, onPick }: { title: string; entries: SubagentEntry[]; onPick: (toolCall: ApiToolCall) => void }) {
  if (entries.length === 0) return null
  return (
    <section className="mb-4 last:mb-0" data-testid={`subagents-${title.toLowerCase()}`}>
      <h3 className="px-2 pb-1.5 text-xs font-normal text-muted-foreground">
        {title} · {entries.length}
      </h3>
      {entries.map(entry => (
        <SubagentListRow key={entry.toolCall.id} entry={entry} onPick={() => onPick(entry.toolCall)} />
      ))}
    </section>
  )
}

/** What the row says under the name: what a working agent is on, or how a finished one ended when it did not simply finish. */
function statusLine(entry: SubagentEntry): string | null {
  if (entry.status === 'running') {
    const tool = entry.activeSubagent?.lastToolName
    return tool ? `Working · ${tool}` : 'Working'
  }
  if (entry.status === 'error') return 'Failed'
  if (entry.status === 'cancelled') return 'Stopped'
  return null
}

function SubagentListRow({ entry, onPick }: { entry: SubagentEntry; onPick: () => void }) {
  const { toolCall, activeSubagent, status } = entry
  const isRunning = status === 'running'
  const line = statusLine(entry)
  const duration = isRunning ? activeSubagent?.usage?.duration_ms : toolCall.subagent?.totalDurationMs
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid="subagents-list-row"
      data-status={status}
      className="group flex w-full items-start gap-2.5 rounded-item px-2 py-2 text-left transition-colors hover:bg-muted/60"
    >
      <SubagentAvatar seed={toolCall.id} size={16} state={isRunning ? 'working' : 'idle'} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]/5 text-foreground">{subagentName(toolCall, activeSubagent)}</span>
        {line && (
          <span className={cn('block truncate text-xs', status === 'error' ? 'text-destructive/80' : 'text-muted-foreground')}>
            {line}
          </span>
        )}
      </span>
      {duration != null && duration > 0 && (
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{formatElapsed(duration)}</span>
      )}
      {/* Opens this subagent's transcript: shown on hover, like a list row that drills in. */}
      <ChevronRight
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  )
}
