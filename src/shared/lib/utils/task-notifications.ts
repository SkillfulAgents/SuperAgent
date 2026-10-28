import { z } from 'zod'

/**
 * `<task-notification>` blocks are SDK/CLI-injected background-task wakes. On the
 * idle path they arrive as their own `user` message (filtered upstream by
 * `isTaskNotificationMessage`), but on the **busy path** — when a background task
 * (e.g. a dynamic workflow) settles while the agent is still mid-turn — the block
 * is appended directly into the assistant's text content and would otherwise
 * render as raw XML.
 *
 * Two shapes occur:
 *   - status-only:   `<task-notification>Task abc123 completed</task-notification>` — pure noise, dropped.
 *   - workflow result: `<task-notification ... type="workflow-complete" ...>{"result": "..."}</task-notification>`
 *     — carries the workflow's return value; surfaced as a structured result instead of being lost.
 *
 * We parse at render time and leave the persisted JSONL untouched (it's the source of truth).
 */

// The result-bearing payload's shape varies by SDK version: ids may be `runId`
// or `run_id`, the timestamp `completedAt` or `completed_at`, and a `type`/
// `task_id`/`status` may or may not be present. Unknown keys are ignored.
const WorkflowCompletePayloadSchema = z.object({
  result: z.string(),
  completedAt: z.string().optional(),
  completed_at: z.string().optional(),
  runId: z.string().optional(),
  run_id: z.string().optional(),
  title: z.string().optional(),
})

export interface WorkflowResultNotification {
  runId?: string
  title?: string
  result: string
  completedAt?: string
}

const TASK_NOTIFICATION_RE = /<task-notification(\s[^>]*)?>([\s\S]*?)<\/task-notification>/g

function attr(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
}

/**
 * Strip `<task-notification>` blocks from a message's text and extract any
 * `workflow-complete` results. Returns the cleaned text plus the parsed results
 * (status-only and malformed blocks are dropped, never surfaced as raw text).
 */
export function parseTaskNotifications(text: string): {
  cleanText: string
  workflowResults: WorkflowResultNotification[]
} {
  if (!text.includes('<task-notification')) return { cleanText: text, workflowResults: [] }

  const workflowResults: WorkflowResultNotification[] = []
  const cleanText = text
    .replace(TASK_NOTIFICATION_RE, (_full, attrs: string | undefined, body: string) => {
      // A workflow-completion notification carries a JSON body with a string
      // `result`. The discriminating `type` may be an XML attribute
      // (`type="workflow-complete"`) OR a field inside the JSON body
      // (`"type":"workflow_completed"`), and ids may be `runId` or `run_id` — so
      // rather than match one shape, we treat ANY task-notification whose body is
      // JSON with a string `result` as a workflow result. Everything else
      // (status-only text like "Task abc completed", or malformed JSON) is dropped
      // as noise. In all cases the raw block is stripped from the displayed text.
      const a = attrs ?? ''
      let payload: unknown
      try {
        payload = JSON.parse(body.trim())
      } catch {
        return '' // non-JSON body — status-only notification
      }
      const parsed = WorkflowCompletePayloadSchema.safeParse(payload)
      if (parsed.success) {
        const p = parsed.data
        workflowResults.push({
          runId: attr(a, 'runId') ?? p.runId ?? p.run_id,
          title: attr(a, 'title') ?? p.title,
          result: p.result,
          completedAt: p.completedAt ?? p.completed_at,
        })
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { cleanText, workflowResults }
}
