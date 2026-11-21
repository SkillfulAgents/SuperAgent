import type { ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'
import type { BackgroundTaskRef } from '@renderer/lib/background-task-label'

export interface BackgroundTaskEntry {
  taskId: string
  kind: 'command' | 'monitor'
  /** What it runs: the command, or the watch's description. */
  detail: string | null
  /** When it started, in ms. */
  startedAt: number | null
  running: boolean
  /** The latest output the agent read back (TaskOutput), or a monitor's events. */
  output: string | null
  /** How a monitor ended, when it has. */
  endReason: string | null
}

/** The tools an agent reads a background task's output with, and the input field naming the task. */
const OUTPUT_TOOLS: Record<string, string[]> = {
  TaskOutput: ['task_id'],
  BashOutput: ['bash_id', 'shell_id'],
}

function resultText(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    const text = result.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('')
    return text || null
  }
  if (result && typeof result === 'object' && typeof (result as { text?: unknown }).text === 'string') return (result as { text: string }).text
  return null
}

function timeOf(value: unknown): number | null {
  if (!value) return null
  const time = new Date(value as string | Date).getTime()
  return Number.isFinite(time) ? time : null
}

/**
 * The session's background commands and monitors: every one the transcript
 * launched, plus any the runtime lists that it has not caught up with. Running
 * is the runtime's word; the rest are done (finished or stopped: the transcript
 * the app reads does not say which). Background subagents and workflows have
 * tabs of their own, so they are left out. Most recent first.
 */
export function collectBackgroundTasks(
  messages: ApiMessageOrBoundary[] | undefined,
  live: readonly BackgroundTaskRef[],
): BackgroundTaskEntry[] {
  const liveIds = new Set(live.filter(task => !task.isSubagent && !task.isWorkflow).map(task => task.taskId))
  const byId = new Map<string, BackgroundTaskEntry>()
  const monitorEvents = new Map<string, string[]>()

  for (const message of messages ?? []) {
    if (message.type === 'monitor_event') {
      const events = monitorEvents.get(message.taskId) ?? []
      events.push(...message.events)
      monitorEvents.set(message.taskId, events)
      const entry = byId.get(message.taskId)
      if (entry && message.endReason) entry.endReason = message.endReason
      continue
    }
    if (message.type !== 'assistant') continue
    for (const call of message.toolCalls as ApiToolCall[]) {
      if ((call.name === 'Bash' || call.name === 'Monitor') && call.backgroundTaskId) {
        const input = call.input as { command?: unknown; description?: unknown; ws?: { url?: unknown } }
        const detail = call.name === 'Bash'
          ? (typeof input.command === 'string' ? input.command : null)
          : (typeof input.description === 'string' && input.description ? input.description
            : typeof input.ws?.url === 'string' ? input.ws.url : typeof input.command === 'string' ? input.command : null)
        byId.set(call.backgroundTaskId, {
          taskId: call.backgroundTaskId,
          kind: call.name === 'Bash' ? 'command' : 'monitor',
          detail,
          startedAt: timeOf(message.createdAt),
          running: false,
          output: null,
          endReason: null,
        })
        continue
      }
      const fields = OUTPUT_TOOLS[call.name]
      if (!fields || call.isError) continue
      const input = call.input as Record<string, unknown>
      const taskId = fields.map(field => input[field]).find((value): value is string => typeof value === 'string')
      const entry = taskId ? byId.get(taskId) : undefined
      const text = resultText(call.result)
      if (entry && text) entry.output = text
    }
  }

  for (const task of live) {
    if (task.isSubagent || task.isWorkflow || byId.has(task.taskId)) continue
    byId.set(task.taskId, {
      taskId: task.taskId,
      kind: task.taskType?.startsWith('monitor_') ? 'monitor' : 'command',
      detail: task.description || null,
      startedAt: task.startedAt,
      running: false,
      output: null,
      endReason: null,
    })
  }

  const entries = [...byId.values()]
  for (const entry of entries) {
    entry.running = liveIds.has(entry.taskId)
    const events = monitorEvents.get(entry.taskId)
    if (entry.kind === 'monitor' && events?.length) entry.output = events.join('\n')
    const started = live.find(task => task.taskId === entry.taskId)?.startedAt
    if (started) entry.startedAt = started
  }
  return entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}
