/**
 * Derive the todo/task list shown in the agent activity indicator from
 * TaskCreate/TaskUpdate tool calls (newer SDK) or TodoWrite (older SDK).
 *
 * Extracted from agent-activity-indicator.tsx so the derivation is testable
 * against real transcript shapes (see derive-task-list.test.ts).
 */

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/**
 * Structural subset of ApiMessage the derivation needs — lets tests feed
 * transformMessages output (TransformedMessage) directly.
 */
export interface TaskSourceMessage {
  type: string
  toolCalls?: Array<{
    name: string
    input: unknown
    result?: unknown
    isError?: boolean
  }>
}

/**
 * Extract the task id the SDK assigned, from the TaskCreate tool result
 * ("Task #7 created successfully: ..."). This is the id TaskUpdate calls
 * reference — the Nth create seen is NOT reliably task #N (resume replays
 * duplicate creates; compaction can drop early ones from the window).
 */
function parseCreatedTaskId(result: unknown): string | null {
  if (typeof result !== 'string') return null
  const match = /^Task #(\d+) created successfully/.exec(result)
  return match ? match[1] : null
}

export function deriveTaskList(messages: TaskSourceMessage[] | undefined): {
  todos: Todo[] | null
  activeItem: Todo | null
} {
  if (!messages) return { todos: null, activeItem: null }

  let list: Todo[] | null = null
  let current: Todo | null = null

  // Try TaskCreate/TaskUpdate first (newer SDK format)
  const taskMap = new Map<string, Todo>()
  let taskCounter = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    for (const tc of message.toolCalls || []) {
      if (tc.name === 'TaskCreate') {
        taskCounter++
        if (tc.isError) continue
        const input = tc.input as { subject?: string; activeForm?: string }
        if (input?.subject) {
          // Key by the real task id when the result has landed; fall back to
          // the call's ordinal position (unprefixed, so a still-streaming
          // create whose ids happen to align keeps matching its updates).
          // First occurrence wins: a duplicated create (replayed history)
          // must not reset the original task's status to pending.
          const key = parseCreatedTaskId(tc.result) ?? String(taskCounter)
          if (taskMap.has(key)) continue
          taskMap.set(key, {
            content: input.subject,
            status: 'pending',
            activeForm: input.activeForm || input.subject,
          })
        }
      } else if (tc.name === 'TaskUpdate') {
        const input = tc.input as { taskId?: string; status?: string }
        if (input?.taskId && taskMap.has(input.taskId)) {
          const task = taskMap.get(input.taskId)!
          if (input.status === 'completed' || input.status === 'in_progress' || input.status === 'pending') {
            task.status = input.status
          }
        }
      }
    }
  }

  if (taskMap.size > 0) {
    list = Array.from(taskMap.values())
    current = list.find((t) => t.status === 'in_progress') || null
  }

  // Fall back to TodoWrite (older SDK format)
  if (!list) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.type !== 'user' && message.type !== 'assistant') continue
      const toolCalls = message.toolCalls || []
      for (let j = toolCalls.length - 1; j >= 0; j--) {
        const toolCall = toolCalls[j]
        if (toolCall.name === 'TodoWrite') {
          try {
            const input = toolCall.input as { todos?: Todo[] }
            if (input?.todos && Array.isArray(input.todos)) {
              list = input.todos
              current = list.find((t) => t.status === 'in_progress') || null
              break
            }
          } catch {
            // Invalid input format, skip
          }
        }
      }
      if (list) break
    }
  }

  return { todos: list, activeItem: current }
}
