/**
 * Schedule Task Tool - Allows agents to schedule tasks for future execution
 *
 * This tool validates the schedule input and returns success. The actual
 * scheduling is handled by the API server which intercepts this tool call
 * and saves the task to the database.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

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

Note: One-time tasks ('at') will execute once and complete. Recurring tasks ('cron') will continue executing on schedule until cancelled.`,
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

    // Return success - the API server will intercept this and handle the actual scheduling
    const taskType = args.scheduleType === 'cron' ? 'recurring' : 'one-time'
    const taskName = args.name || 'Scheduled Task'

    console.log(`[schedule_task] Task "${taskName}" scheduled successfully`)

    return {
      content: [
        {
          type: 'text' as const,
          text: `Scheduled ${taskType} task "${taskName}".

Schedule: ${args.scheduleExpression}
Task: ${args.prompt.substring(0, 100)}${args.prompt.length > 100 ? '...' : ''}

The task has been registered and will be executed according to the schedule. ${
            args.scheduleType === 'cron'
              ? 'This recurring task will continue until cancelled.'
              : 'This one-time task will be removed after execution.'
          }`,
        },
      ],
    }
  }
)
