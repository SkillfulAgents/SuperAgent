import type { ApiMessageOrBoundary, ApiToolCall } from '@shared/lib/types/api'

/**
 * What a background task IS, for the places that list them by name: the
 * per-task rows in the activity card and the Stop dialog's "these are still
 * running" list. The stream only carries task ids; the launching tool call in
 * the transcript carries the command, the subagent's type and description.
 */

export interface BackgroundTaskRef {
  taskId: string
  startedAt: number
  isWorkflow?: boolean
  isSubagent?: boolean
}

export interface BackgroundTaskLabel {
  /** What kind of work: the subagent type, "Background command", "Background workflow". */
  title: string
  /** The command or description, when the transcript has it. */
  detail: string | null
}

export interface LabeledBackgroundTask extends BackgroundTaskRef, BackgroundTaskLabel {}

// The CLI's tool_result text for a backgrounded Bash call names the task:
// "Command running in background with ID: bg_abc123. Output is being…"
const BACKGROUND_ID_PATTERN = /background with ID:\s*([A-Za-z0-9_-]+)/i

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('')
  }
  if (result && typeof result === 'object' && typeof (result as { text?: unknown }).text === 'string') {
    return (result as { text: string }).text
  }
  return ''
}

function genericLabel(task: BackgroundTaskRef): BackgroundTaskLabel {
  if (task.isWorkflow) return { title: 'Background workflow', detail: null }
  if (task.isSubagent) return { title: 'Background agent', detail: null }
  return { title: 'Background command', detail: null }
}

/** Join every background task to the tool call that launched it. */
export function labelBackgroundTasks(
  tasks: readonly BackgroundTaskRef[],
  messages: readonly ApiMessageOrBoundary[] | undefined,
): LabeledBackgroundTask[] {
  if (tasks.length === 0) return []
  const byTaskId = new Map<string, BackgroundTaskLabel>()

  for (const message of messages ?? []) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    for (const call of (message.toolCalls ?? []) as ApiToolCall[]) {
      if (call.name === 'Bash') {
        // The API carries the id the runtime assigned; the result text is the
        // fallback for transcripts shaped before it did.
        const taskId = call.backgroundTaskId ?? BACKGROUND_ID_PATTERN.exec(resultText(call.result))?.[1]
        if (!taskId) continue
        const command = typeof call.input.command === 'string' ? call.input.command : null
        byTaskId.set(taskId, { title: 'Background command', detail: command })
      } else if ((call.name === 'Agent' || call.name === 'Task') && call.subagent?.agentId) {
        const input = call.input as { subagent_type?: unknown; description?: unknown }
        byTaskId.set(call.subagent.agentId, {
          title: typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'Agent',
          detail: typeof input.description === 'string' && input.description ? input.description : null,
        })
      }
    }
  }

  return tasks.map((task) => ({ ...task, ...(byTaskId.get(task.taskId) ?? genericLabel(task)) }))
}
