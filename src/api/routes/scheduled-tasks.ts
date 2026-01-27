/**
 * Scheduled Tasks API Routes
 *
 * Endpoints for viewing and cancelling scheduled tasks.
 * Note: Listing tasks by agent is in agents.ts since it's under /api/agents/:agentSlug/
 */

import { Hono } from 'hono'
import {
  getScheduledTask,
  cancelScheduledTask,
  resetScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import { getSessionsByScheduledTask } from '@shared/lib/services/session-service'

const scheduledTasksRouter = new Hono()

// GET /api/scheduled-tasks/:taskId - Get a single scheduled task
scheduledTasksRouter.get('/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId')
    const task = await getScheduledTask(taskId)

    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404)
    }

    return c.json(task)
  } catch (error) {
    console.error('Failed to fetch scheduled task:', error)
    return c.json({ error: 'Failed to fetch scheduled task' }, 500)
  }
})

// GET /api/scheduled-tasks/:taskId/sessions - Get all sessions created by this scheduled task
scheduledTasksRouter.get('/:taskId/sessions', async (c) => {
  try {
    const taskId = c.req.param('taskId')

    // First get the task to find its agent
    const task = await getScheduledTask(taskId)
    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404)
    }

    const sessions = await getSessionsByScheduledTask(task.agentSlug, taskId)
    return c.json(sessions)
  } catch (error) {
    console.error('Failed to fetch sessions for scheduled task:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// DELETE /api/scheduled-tasks/:taskId - Cancel a scheduled task
scheduledTasksRouter.delete('/:taskId', async (c) => {
  try {
    const taskId = c.req.param('taskId')
    const cancelled = await cancelScheduledTask(taskId)

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
scheduledTasksRouter.post('/:taskId/reset', async (c) => {
  try {
    const taskId = c.req.param('taskId')
    const reset = await resetScheduledTask(taskId)

    if (!reset) {
      return c.json({ error: 'Scheduled task not found' }, 404)
    }

    const task = await getScheduledTask(taskId)
    return c.json(task)
  } catch (error) {
    console.error('Failed to reset scheduled task:', error)
    return c.json({ error: 'Failed to reset scheduled task' }, 500)
  }
})

export default scheduledTasksRouter
