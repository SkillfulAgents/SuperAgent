/**
 * What a page cut short by a soft budget (`soft_bytes` + `min_turns`) must
 * still hold, decided from raw transcript rows as the page scan walks them
 * newest first. Two things, both there so the shorter page shows what the
 * default one does:
 *
 *  - enough turns the message list draws (`startsVisibleTurnRow`), or the
 *    list can come out shorter than its viewport, or empty;
 *  - the `TaskCreate` of every `TaskUpdate` in the page (`TaskReferences`),
 *    or the activity card drops a task whose update it can see and whose
 *    subject it cannot.
 *
 * While either is missing the soft budget does not stop the scan, and the
 * page is placed by the default budget exactly as without it.
 */
import type { ContentBlock, JsonlMessageEntry } from '@shared/lib/types/agent'
import { isTaskNotificationMessage } from '@shared/lib/utils/message-transform'
import { startsVisibleTurn } from '@shared/lib/utils/visible-turn-start'

/** A user row's text as the transform builds it: the string, or its text blocks joined. */
function userRowText(entry: JsonlMessageEntry): string {
  const content = entry.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * Whether a row the scan counted as a display item opens a turn the list
 * draws: a user message, not queued mid-turn, not a monitor's notification,
 * and not one of the messages the list hides or folds.
 */
export function startsVisibleTurnRow(entry: JsonlMessageEntry): boolean {
  if (entry.type !== 'user' || entry.isQueuedCommand) return false
  if (isTaskNotificationMessage(entry)) return false
  return startsVisibleTurn(userRowText(entry))
}

const TASK_CREATED = /^Task #(\d+) created successfully/

function createdTaskId(result: unknown): string | null {
  const text = typeof result === 'string'
    ? result
    : Array.isArray(result)
      ? (result as { type?: string; text?: unknown }[]).find((b) => b?.type === 'text' && typeof b.text === 'string')?.text as string | undefined
      : undefined
  return text ? (TASK_CREATED.exec(text)?.[1] ?? null) : null
}

/**
 * The tasks a window's `TaskUpdate` calls name, less those whose `TaskCreate`
 * call the window also holds. Rows arrive newest first, so a create's result
 * (which carries the id the updates use) is seen before the call it answers.
 */
export class TaskReferences {
  private readonly wanted = new Set<string>()
  private readonly created = new Set<string>()
  /** tool_use id of a TaskCreate → the task id its result reported. */
  private readonly createResults = new Map<string, string>()

  /** True while some update's create lies below the rows seen so far. */
  get open(): boolean {
    return this.wanted.size > 0
  }

  /** Takes one row in. True when the row holds a `TaskCreate` call. */
  see(entry: JsonlMessageEntry): boolean {
    const content = entry.message.content
    if (!Array.isArray(content)) return false
    let holdsCreate = false
    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        const taskId = createdTaskId(block.content)
        if (taskId) this.createResults.set(block.tool_use_id, taskId)
      } else if (block.type === 'tool_use') {
        if (block.name === 'TaskUpdate') {
          const taskId = (block.input as { taskId?: unknown } | undefined)?.taskId
          if ((typeof taskId === 'string' || typeof taskId === 'number') && !this.created.has(String(taskId))) {
            this.wanted.add(String(taskId))
          }
        } else if (block.name === 'TaskCreate') {
          holdsCreate = true
          const taskId = this.createResults.get(block.id)
          if (taskId) {
            this.created.add(taskId)
            this.wanted.delete(taskId)
          }
        }
      }
    }
    return holdsCreate
  }
}
