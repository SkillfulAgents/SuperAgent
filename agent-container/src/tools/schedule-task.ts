/**
 * Schedule Task Tool - Allows agents to schedule tasks for future execution
 *
 * This tool validates the schedule input and returns success. The actual
 * scheduling is handled by the API server which intercepts this tool call
 * and saves the task to the database.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'

/**
 * How long to wait for the host to confirm the schedule before giving up.
 * Unlike user-input tools (secret/question) that legitimately block on a human,
 * schedule_task waits only on a fast automated host operation (a DB write), so a
 * host that never responds means something is wrong — fail loud instead of
 * hanging the agent session forever.
 */
const SCHEDULE_TASK_HOST_TIMEOUT_MS = 60_000

/**
 * Basic validation for cron expression (5-6 space-separated fields)
 */
function isValidCronFormat(expression: string): boolean {
  const parts = expression.trim().split(/\s+/)
  // Standard cron has 5 fields, some implementations have 6 (with seconds)
  return parts.length >= 5 && parts.length <= 6
}

/**
 * Basic validation for "at" expression
 */
function isValidAtFormat(expression: string): boolean {
  const normalized = expression.trim().toLowerCase()
  // Must start with "at " and have something after it
  return normalized.startsWith('at ') && normalized.length > 3
}

export const scheduleTaskTool = tool(
  'schedule_task',
  `Schedule a task to be executed at a specific time or recurring interval.

For one-time tasks, use 'at' syntax:
- "at now + 1 hour" - Execute 1 hour from now
- "at now + 2 days" - Execute 2 days from now
- "at tomorrow 9am" - Execute tomorrow at 9 AM
- "at next monday" - Execute next Monday
- "at 2024-03-15 14:00" - Execute at specific date/time

For recurring tasks, use cron syntax (5 fields: minute hour day-of-month month day-of-week):
- "0 0 * * *" - Daily at midnight
- "0 9 * * 1-5" - Weekdays at 9 AM
- "*/15 * * * *" - Every 15 minutes
- "0 0 1 * *" - First day of every month at midnight

The prompt you provide will be sent to the agent as a new conversation at the scheduled time.
The task will be executed in a new session, and the agent will have full access to tools and capabilities.

Note: One-time tasks ('at') will execute once and complete. Recurring tasks ('cron') will continue executing on schedule indefinitely until cancelled — there is no expiration or time limit.

Avoid recurring intervals shorter than 15 minutes unless truly necessary: frequent runs can pile up and are costly, especially on Opus or at high effort.`,
  {
    scheduleType: z
      .enum(['at', 'cron'])
      .describe('Type of schedule: "at" for one-time execution, "cron" for recurring'),
    scheduleExpression: z
      .string()
      .describe(
        'The schedule expression. For "at": use natural language like "at now + 1 hour" or "at tomorrow 9am". For "cron": use standard cron syntax like "0 9 * * 1-5"'
      ),
    prompt: z
      .string()
      .describe(
        'The prompt/task to execute at the scheduled time. This will be sent to the agent as a new conversation.'
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Optional display name for this scheduled task (e.g., "Daily backup", "Send weekly report")'
      ),
    timezone: z
      .string()
      .optional()
      .describe(
        'Optional IANA timezone for interpreting the schedule (e.g., "America/New_York", "Europe/London"). If not specified, uses the creating user\'s timezone.'
      ),
    model: z
      .enum(['opus', 'sonnet', 'haiku'])
      .optional()
      .describe(
        'Optional model family to use for this task. If not specified, uses the global default.'
      ),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'])
      .optional()
      .describe(
        'Optional effort level for this task. If not specified, uses the global default.'
      ),
  },
  async (args) => {
    console.log(`[schedule_task] Scheduling ${args.scheduleType} task: ${args.scheduleExpression}`)

    // Basic format validation
    if (args.scheduleType === 'at') {
      if (!isValidAtFormat(args.scheduleExpression)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid 'at' expression: "${args.scheduleExpression}". Expected format: "at <time>", e.g., "at now + 1 hour" or "at tomorrow 9am"`,
            },
          ],
          isError: true,
        }
      }
    } else {
      if (!isValidCronFormat(args.scheduleExpression)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron expression: "${args.scheduleExpression}". Expected 5-6 space-separated fields, e.g., "0 9 * * 1-5" (minute hour day-of-month month day-of-week)`,
            },
          ],
          isError: true,
        }
      }
    }

    // Validate prompt is not empty
    if (!args.prompt.trim()) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Prompt cannot be empty. Please provide a task description for the agent to execute.',
          },
        ],
        isError: true,
      }
    }

    // Blocking: the host persists the task and resolves this tool only after the
    // schedule is actually saved. This avoids the false-success bug where the
    // tool reported "scheduled" while host persistence happened (and could fail)
    // in the background. The host's resolved message also carries any
    // too-frequent-interval warning.
    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    // Bound the wait so a host that never resolves/rejects (e.g. a handler that
    // bails before reaching the container) surfaces an error instead of hanging
    // the session indefinitely.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        inputManager.createPendingWithType<string>(toolUseId, 'schedule_task'),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out waiting for the host to confirm the schedule')),
            SCHEDULE_TASK_HOST_TIMEOUT_MS,
          )
        }),
      ])

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to schedule task: ${msg}` }],
        isError: true,
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }
)

export const listScheduledTasksTool = tool(
  'list_scheduled_tasks',
  `List the scheduled tasks for this agent that are still on the schedule (pending or paused).

Returns each task's ID, name, schedule type ("at" for one-time, "cron" for recurring), schedule expression, next execution time, and prompt. Use the returned task ID with cancel_scheduled_task to remove a task.

This only shows tasks that are still scheduled — it does not include tasks that have already executed, failed, or been cancelled.`,
  {},
  async () => {
    console.log('[list_scheduled_tasks] Fetching scheduled tasks')

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'list_scheduled_tasks',
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to list scheduled tasks: ${msg}` }],
        isError: true,
      }
    }
  }
)

export const cancelScheduledTaskTool = tool(
  'cancel_scheduled_task',
  `Cancel a scheduled task by ID. This removes the task from the schedule so it will no longer execute.

Use list_scheduled_tasks first to find the task ID. Only pending or paused tasks can be cancelled — tasks that have already executed or been cancelled cannot.`,
  {
    task_id: z
      .string()
      .describe('The ID of the scheduled task to cancel (from list_scheduled_tasks)'),
  },
  async (args) => {
    console.log(`[cancel_scheduled_task] Cancelling task ${args.task_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'cancel_scheduled_task',
        { task_id: args.task_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to cancel scheduled task: ${msg}` }],
        isError: true,
      }
    }
  }
)

export const pauseScheduledTaskTool = tool(
  'pause_scheduled_task',
  `Pause a recurring (cron) scheduled task by ID. A paused task stays on the schedule but does not execute until resumed with resume_scheduled_task.

Use list_scheduled_tasks first to find the task ID. Only active recurring tasks can be paused — one-time ("at") tasks cannot.`,
  {
    task_id: z
      .string()
      .describe('The ID of the recurring scheduled task to pause (from list_scheduled_tasks)'),
  },
  async (args) => {
    console.log(`[pause_scheduled_task] Pausing task ${args.task_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'pause_scheduled_task',
        { task_id: args.task_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to pause scheduled task: ${msg}` }],
        isError: true,
      }
    }
  }
)

export const resumeScheduledTaskTool = tool(
  'resume_scheduled_task',
  `Resume a paused recurring (cron) scheduled task by ID. The next execution time is recomputed from the cron expression, so any executions missed while paused are skipped.

Use list_scheduled_tasks first to find the task ID. Only paused recurring tasks can be resumed.`,
  {
    task_id: z
      .string()
      .describe('The ID of the paused scheduled task to resume (from list_scheduled_tasks)'),
  },
  async (args) => {
    console.log(`[resume_scheduled_task] Resuming task ${args.task_id}`)

    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return {
        content: [{ type: 'text' as const, text: 'Unable to process request — no tool use ID available.' }],
        isError: true,
      }
    }

    try {
      const result = await inputManager.createPendingWithType<string>(
        toolUseId,
        'resume_scheduled_task',
        { task_id: args.task_id },
      )

      return {
        content: [{ type: 'text' as const, text: result }],
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: `Failed to resume scheduled task: ${msg}` }],
        isError: true,
      }
    }
  }
)
