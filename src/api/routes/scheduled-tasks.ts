/**
 * Scheduled Tasks API Routes
 *
 * Endpoints for viewing, cancelling, running, and editing scheduled tasks.
 * Note: Listing tasks by agent is in agents.ts since it's under /api/agents/:agentSlug/
 */

import { Hono } from 'hono'
import { getConfiguredLlmClient, createSummarizerText } from '@shared/lib/llm-provider/helpers'
import { resolveActiveProviderModel } from '@shared/lib/llm-provider'
import {
  getScheduledTask,
  cancelScheduledTask,
  resetScheduledTask,
  updateTaskTimezone,
  markTaskExecuted,
  recordManualExecution,
  updateScheduleExpression,
  updateTaskPrompt,
  updateTaskName,
  updateTaskRuntimeOptions,
  pauseScheduledTask,
  resumeScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import { promptUpdateSchema } from './trigger-prompt-schema'
import {
  getSessionsByScheduledTask,
  registerSession,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import { getSecretEnvVars } from '@shared/lib/services/secrets-service'
import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { getEffectiveModels } from '@shared/lib/config/settings'
import { readAgentPreferences } from '@shared/lib/services/agent-preferences-service'
import { validateCronExpression, getFrequencyWarning } from '@shared/lib/services/schedule-parser'
import { RuntimeOptionsSchema } from '@shared/lib/container/runtime-options'
import type { EffortLevel } from '@shared/lib/container/types'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { deliverSessionWake } from '@shared/lib/scheduler/wake-delivery'
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
    const sessionsWithStatus = sessions.map((session) => ({
      ...session,
      isActive: messagePersister.isSessionActive(session.id),
    }))
    return c.json(sessionsWithStatus)
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

    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'deleted' })

    // Cancelling a session wake changes that session's list/badge state.
    if (task!.resumeSessionId) {
      messagePersister.broadcastGlobal({
        type: 'session_updated',
        sessionId: task!.resumeSessionId,
        agentSlug: task!.agentSlug,
      })
      messagePersister.broadcastSessionUpdate(task!.resumeSessionId)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to cancel scheduled task:', error)
    return c.json({ error: 'Failed to cancel scheduled task' }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/pause - Pause a recurring cron task
scheduledTasksRouter.post('/:taskId/pause', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task || task.scheduleType !== 'cron') {
      return c.json({ error: 'Only recurring cron tasks can be paused' }, 400)
    }
    const paused = await pauseScheduledTask(task.id)
    if (!paused) {
      return c.json({ error: 'Task is not pending' }, 400)
    }
    const updated = await getScheduledTask(task.id)
    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'paused' })
    return c.json(updated)
  } catch (error) {
    console.error('Failed to pause scheduled task:', error)
    return c.json({ error: 'Failed to pause scheduled task' }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/resume - Resume a paused cron task
scheduledTasksRouter.post('/:taskId/resume', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }
    const resumed = await resumeScheduledTask(task.id)
    if (!resumed) {
      return c.json({ error: 'Task is not paused' }, 400)
    }
    const updated = await getScheduledTask(task.id)
    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'resumed' })
    return c.json(updated)
  } catch (error) {
    console.error('Failed to resume scheduled task:', error)
    return c.json({ error: 'Failed to resume scheduled task' }, 500)
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

// PATCH /api/scheduled-tasks/:taskId/prompt - Edit the task's instructions
scheduledTasksRouter.patch('/:taskId/prompt', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const body = await c.req.json().catch(() => ({}))
    const parsed = promptUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid prompt' }, 400)
    }

    const updated = await updateTaskPrompt(task!.id, parsed.data.prompt)
    if (!updated) {
      return c.json({ error: 'Task not found or not editable' }, 404)
    }

    const refreshed = await getScheduledTask(task!.id)
    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'updated', details: { field: 'prompt' } })
    return c.json(refreshed)
  } catch (error) {
    console.error('Failed to update scheduled task prompt:', error)
    return c.json({ error: 'Failed to update prompt' }, 500)
  }
})

// PATCH /api/scheduled-tasks/:taskId/name - Rename a scheduled task
scheduledTasksRouter.patch('/:taskId/name', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const body = await c.req.json().catch(() => ({}))
    const { name } = body as { name?: unknown }

    if (typeof name !== 'string' || !name.trim()) {
      return c.json({ error: 'name is required and must be a non-empty string' }, 400)
    }

    const updated = await updateTaskName(task!.id, name.trim())
    if (!updated) {
      return c.json({ error: 'Task not found or not editable' }, 404)
    }

    const refreshed = await getScheduledTask(task!.id)
    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'updated', details: { field: 'name' } })
    return c.json(refreshed)
  } catch (error) {
    console.error('Failed to update scheduled task name:', error)
    return c.json({ error: 'Failed to update name' }, 500)
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

// PATCH /api/scheduled-tasks/:taskId/runtime-options - Update model and/or effort
scheduledTasksRouter.patch('/:taskId/runtime-options', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const body = await c.req.json().catch(() => ({}))
    // Per-task speed overrides are a deliberate non-feature: omit speed so a
    // PATCH carrying it fails validation (strict schema) instead of returning
    // 200 while silently dropping it.
    const parsed = RuntimeOptionsSchema.omit({ speed: true }).partial().safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid runtime options' }, 400)
    }

    const updates: { model?: string | null; effort?: string | null } = {}
    if ('model' in body) updates.model = parsed.data.model ?? null
    if ('effort' in body) updates.effort = parsed.data.effort ?? null

    const updated = await updateTaskRuntimeOptions(task!.id, updates)
    if (!updated) {
      return c.json({ error: 'Task not found or not editable' }, 404)
    }

    const refreshed = await getScheduledTask(task!.id)
    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'updated', details: { field: 'runtime-options' } })
    return c.json(refreshed)
  } catch (error) {
    console.error('Failed to update scheduled task runtime options:', error)
    return c.json({ error: 'Failed to update runtime options' }, 500)
  }
})

// POST /api/scheduled-tasks/:taskId/run-now - Execute a scheduled task immediately
scheduledTasksRouter.post('/:taskId/run-now', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    if (!task || (task.status !== 'pending' && task.status !== 'paused')) {
      return c.json({ error: 'Task is not pending' }, 400)
    }

    // Session wake ("Wake now"): resume the target session instead of creating
    // a new one. deliverSessionWake is the same claimed path the scheduler
    // uses, so a poll firing at the same instant can never double-deliver.
    if (task.resumeSessionId) {
      const result = await deliverSessionWake(task, 'manual')

      if (result.outcome === 'delivered' || result.outcome === 'reconciled') {
        const updated = await getScheduledTask(task.id)
        return c.json({ sessionId: result.sessionId, agentSlug: task.agentSlug, task: updated }, 201)
      }
      if (result.outcome === 'in-flight') {
        return c.json({ error: 'This wake is already being delivered' }, 409)
      }
      if (result.outcome === 'session-missing') {
        return c.json({ error: 'The session this wake resumes no longer exists' }, 404)
      }
      if (result.outcome === 'agent-missing') {
        return c.json({ error: 'Agent no longer exists' }, 404)
      }
      // not-pending: a concurrent delivery just finished, or the wake was cancelled
      return c.json({ error: 'Task is not pending' }, 400)
    }

    const client = await containerManager.ensureRunning(task.agentSlug)
    const availableEnvVars = await getSecretEnvVars(task.agentSlug)
    // Model/effort preference order: task override > agent default > global default.
    const models = getEffectiveModels()
    const agentPrefs = await readAgentPreferences(task.agentSlug)
    const effort = task.effort ?? agentPrefs.defaultEffort

    const containerSession = await client.createSession({
      availableEnvVars: availableEnvVars.length > 0 ? availableEnvVars : undefined,
      initialMessage: task.prompt,
      model: task.model || agentPrefs.defaultModel || models.agentModel,
      browserModel: models.browserModel,
      dashboardBuilderModel: models.dashboardBuilderModel,
      ...(effort ? { effort: effort as EffortLevel } : {}),
      ...(agentPrefs.defaultSpeed ? { speed: agentPrefs.defaultSpeed } : {}),
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
    const description = await createSummarizerText(client, {
      model: resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer'),
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
    const expression = await createSummarizerText(client, {
      model: resolveActiveProviderModel(getEffectiveModels().summarizerModel, 'summarizer'),
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
      return c.json({ error: 'Task not found or not editable' }, 404)
    }

    const refreshed = await getScheduledTask(task.id)
    logAuditEvent({ userId: getCurrentUserId(c), object: 'task', objectId: task!.id, action: 'updated', details: { field: 'schedule' } })

    // Surface the same too-frequent-interval warning as the agent path. The edit
    // still succeeds — the warning is advisory.
    const warning = getFrequencyWarning('cron', body.scheduleExpression.trim(), task.timezone || undefined)
    return c.json(warning ? { ...refreshed, warning } : refreshed)
  } catch (error) {
    console.error('Failed to update schedule:', error)
    return c.json({ error: 'Failed to update schedule' }, 500)
  }
})

export default scheduledTasksRouter
