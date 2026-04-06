/**
 * Scheduled Tasks API Routes
 *
 * Endpoints for viewing, cancelling, running, and editing scheduled tasks.
 * Note: Listing tasks by agent is in agents.ts since it's under /api/agents/:agentSlug/
 */

import { Hono } from 'hono'
import { getConfiguredLlmClient, extractTextFromLlmResponse } from '@shared/lib/llm-provider/helpers'
import {
  getScheduledTask,
  cancelScheduledTask,
  resetScheduledTask,
  updateTaskTimezone,
  markTaskExecuted,
  recordManualExecution,
  updateScheduleExpression,
} from '@shared/lib/services/scheduled-task-service'
import {
  getSessionsByScheduledTask,
  registerSession,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { validateCronExpression } from '@shared/lib/services/schedule-parser'
import { withRetry } from '@shared/lib/utils/retry'
import { Authenticated, EntityAgentRole } from '../middleware/auth'

const scheduledTasksRouter = new Hono()

scheduledTasksRouter.use('*', Authenticated())

const TaskAgentRole = EntityAgentRole({
  paramName: 'taskId',
  lookupFn: getScheduledTask,
  contextKey: 'scheduledTask',
  entityName: 'Scheduled task',
})

// GET /api/scheduled-tasks/:taskId - Get a single scheduled task
scheduledTasksRouter.get('/:taskId', TaskAgentRole('viewer'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never)
    return c.json(task)
  } catch (error) {
    console.error('Failed to fetch scheduled task:', error)
    return c.json({ error: 'Failed to fetch scheduled task' }, 500)
  }
})

// GET /api/scheduled-tasks/:taskId/sessions - Get all sessions created by this scheduled task
scheduledTasksRouter.get('/:taskId/sessions', TaskAgentRole('viewer'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const sessions = await getSessionsByScheduledTask(task!.agentSlug, task!.id)
    return c.json(sessions)
  } catch (error) {
    console.error('Failed to fetch sessions for scheduled task:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// DELETE /api/scheduled-tasks/:taskId - Cancel a scheduled task
scheduledTasksRouter.delete('/:taskId', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const cancelled = await cancelScheduledTask(task!.id)

    if (!cancelled) {
      return c.json({ error: 'Scheduled task not found or already cancelled' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to cancel scheduled task:', error)
    return c.json({ error: 'Failed to cancel scheduled task' }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/reset - Reset a failed/cancelled task back to pending
scheduledTasksRouter.post('/:taskId/reset', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const reset = await resetScheduledTask(task!.id)

    if (!reset) {
      return c.json({ error: 'Scheduled task not found' }, 404)
    }

    const updated = await getScheduledTask(task!.id)
    return c.json(updated)
  } catch (error) {
    console.error('Failed to reset scheduled task:', error)
    return c.json({ error: 'Failed to reset scheduled task' }, 500)
  }
})

// PATCH /api/scheduled-tasks/:taskId/timezone - Update a task's timezone
scheduledTasksRouter.patch('/:taskId/timezone', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const body = await c.req.json<{ timezone: string }>()

    if (!body.timezone || typeof body.timezone !== 'string') {
      return c.json({ error: 'timezone is required and must be a string' }, 400)
    }

    // Validate IANA timezone name
    try {
      Intl.DateTimeFormat(undefined, { timeZone: body.timezone })
    } catch {
      return c.json({ error: 'Invalid timezone identifier' }, 400)
    }

    const updated = await updateTaskTimezone(task!.id, body.timezone)
    if (!updated) {
      return c.json({ error: 'Task not found or not pending' }, 404)
    }

    const refreshed = await getScheduledTask(task!.id)
    return c.json(refreshed)
  } catch (error) {
    console.error('Failed to update scheduled task timezone:', error)
    return c.json({ error: 'Failed to update timezone' }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/run-now - Execute a scheduled task immediately
scheduledTasksRouter.post('/:taskId/run-now', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task || task.status !== 'pending') {
      return c.json({ error: 'Task is not pending' }, 400)
    }

    const client = await containerManager.ensureRunning(task.agentSlug)
    const availableEnvVars = await getSecretEnvVars(task.agentSlug)

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: task.prompt,
      model: getEffectiveModels().agentModel,
      browserModel: getEffectiveModels().browserModel,
    })

    const sessionId = containerSession.id
    const sessionName = task.name || 'Scheduled Task (Run Now)'

    await registerSession(task.agentSlug, sessionId, sessionName)
    await updateSessionMetadata(task.agentSlug, sessionId, {
      isScheduledExecution: true,
      scheduledTaskId: task.id,
      scheduledTaskName: task.name || undefined,
    })

    await messagePersister.subscribeToSession(sessionId, client, sessionId, task.agentSlug)
    messagePersister.markSessionActive(sessionId, task.agentSlug)

    if (task.isRecurring) {
      // Recurring: keep schedule, just record the manual execution
      await recordManualExecution(task.id, sessionId)
    } else {
      // One-time: cancel the schedule and mark as executed
      await markTaskExecuted(task.id, sessionId)
    }

    const updated = await getScheduledTask(task.id)
    return c.json({
      sessionId,
      agentSlug: task.agentSlug,
      task: updated,
    }, 201)
  } catch (error) {
    console.error('Failed to run scheduled task now:', error)
    return c.json({ error: 'Failed to run scheduled task' }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/describe-schedule - Translate cron expression to English
scheduledTasksRouter.post('/:taskId/describe-schedule', TaskAgentRole('viewer'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task || task.scheduleType !== 'cron') {
      return c.json({ error: 'Task is not a recurring cron task' }, 400)
    }

    const client = getConfiguredLlmClient()
    const response = await withRetry(() =>
      client.messages.create({
        model: getEffectiveModels().summarizerModel,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: `Translate the following crontab expression to a concise human-readable English description. Respond with ONLY the description, nothing else. No quotes, no explanation.

Cron expression: ${task.scheduleExpression}

Examples:
"0 9 * * 1-5" → "Every weekday at 9:00 AM"
"*/15 * * * *" → "Every 15 minutes"
"0 0 1 * *" → "First day of every month at midnight"`,
          },
        ],
      })
    )

    const description = extractTextFromLlmResponse(response)
    if (!description) {
      return c.json({ error: 'Failed to generate description' }, 500)
    }

    return c.json({ description })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to describe schedule'
    console.error('Failed to describe schedule:', error)
    return c.json({ error: msg }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/parse-schedule - Convert English description to cron expression
scheduledTasksRouter.post('/:taskId/parse-schedule', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task || task.scheduleType !== 'cron') {
      return c.json({ error: 'Task is not a recurring cron task' }, 400)
    }

    const body = await c.req.json<{ description: string }>()
    if (!body.description?.trim()) {
      return c.json({ error: 'description is required' }, 400)
    }

    const client = getConfiguredLlmClient()
    const response = await withRetry(() =>
      client.messages.create({
        model: getEffectiveModels().summarizerModel,
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `Convert the following English schedule description to a standard 5-field crontab expression (minute hour day-of-month month day-of-week). Respond with ONLY the cron expression, nothing else. No quotes, no explanation.

Description: ${body.description.trim()}

Examples:
"Every weekday at 9:00 AM" → 0 9 * * 1-5
"Every 15 minutes" → */15 * * * *
"First day of every month at midnight" → 0 0 1 * *`,
          },
        ],
      })
    )

    const expression = extractTextFromLlmResponse(response)
    if (!expression) {
      return c.json({ error: 'Failed to generate cron expression' }, 500)
    }

    // Validate the generated cron expression
    try {
      const result = validateCronExpression(expression)
      if (!result.valid) throw new Error('Invalid')
    } catch {
      return c.json({
        error: 'Generated expression is not valid cron syntax',
        expression,
      }, 422)
    }

    return c.json({ expression })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to parse schedule'
    console.error('Failed to parse schedule description:', error)
    return c.json({ error: msg }, 500)
  }
})

// PATCH /api/scheduled-tasks/:taskId/schedule - Update a recurring task's cron expression
scheduledTasksRouter.patch('/:taskId/schedule', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task || task.scheduleType !== 'cron') {
      return c.json({ error: 'Task is not a recurring cron task' }, 400)
    }

    const body = await c.req.json<{ scheduleExpression: string }>()
    if (!body.scheduleExpression?.trim()) {
      return c.json({ error: 'scheduleExpression is required' }, 400)
    }

    // Validate cron expression
    try {
      const result = validateCronExpression(body.scheduleExpression.trim())
      if (!result.valid) throw new Error('Invalid')
    } catch {
      return c.json({ error: 'Invalid cron expression' }, 400)
    }

    const updated = await updateScheduleExpression(task.id, body.scheduleExpression.trim())
    if (!updated) {
      return c.json({ error: 'Task not found or not pending' }, 404)
    }

    const refreshed = await getScheduledTask(task.id)
    return c.json(refreshed)
  } catch (error) {
    console.error('Failed to update schedule:', error)
    return c.json({ error: 'Failed to update schedule' }, 500)
  }
})

export default scheduledTasksRouter
