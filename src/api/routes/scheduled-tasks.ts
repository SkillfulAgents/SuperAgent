/**
 * Scheduled Tasks API Routes
 *
 * Endpoints for viewing and cancelling scheduled tasks.
 * Note: Listing tasks by agent is in agents.ts since it's under /api/agents/:agentSlug/
 */

import { Hono } from 'hono'
import type { Context, Next, MiddlewareHandler } from 'hono'
import { and, eq } from 'drizzle-orm'
import {
  getScheduledTask,
  cancelScheduledTask,
  resetScheduledTask,
  deleteScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import { getSessionsByScheduledTask, getSession } from '@shared/lib/services/session-service'
import { Authenticated } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'

const scheduledTasksRouter = new Hono()

scheduledTasksRouter.use('*', Authenticated())

type AgentRole = 'owner' | 'user' | 'viewer'
const ROLE_HIERARCHY: Record<AgentRole, number> = { viewer: 0, user: 1, owner: 2 }

/**
 * Middleware that loads the scheduled task, checks the user's role on its agent,
 * and stashes the task on the context for downstream handlers.
 */
function TaskAgentRole(minRole: AgentRole): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const taskId = c.req.param('taskId')
    const task = await getScheduledTask(taskId)
    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404)
    }
    c.set('scheduledTask' as never, task as never)

    if (!isAuthMode()) return next()

    const userId = getCurrentUserId(c)
    const [row] = await db
      .select({ role: agentAcl.role })
      .from(agentAcl)
      .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, task.agentSlug)))
      .limit(1)

    const userRole = (row?.role as AgentRole) ?? null
    if (!userRole || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minRole]) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  }
}

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

// GET /api/scheduled-tasks/:taskId/sessions - Get all sessions related to this scheduled task
scheduledTasksRouter.get('/:taskId/sessions', TaskAgentRole('viewer'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>
    const sessions = await getSessionsByScheduledTask(task!.agentSlug, task!.id)
    const sessionIds = new Set(sessions.map((s) => s.id))

    if (task!.targetSessionId && !sessionIds.has(task!.targetSessionId)) {
      const targetSession = await getSession(task!.agentSlug, task!.targetSessionId)
      if (targetSession) sessions.unshift(targetSession)
    }

    return c.json(sessions)
  } catch (error) {
    console.error('Failed to fetch sessions for scheduled task:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// DELETE /api/scheduled-tasks/:taskId - Cancel or delete a scheduled task
scheduledTasksRouter.delete('/:taskId', TaskAgentRole('user'), async (c) => {
  try {
    const task = c.get('scheduledTask' as never) as Awaited<ReturnType<typeof getScheduledTask>>

    if (task!.status === 'pending') {
      const cancelled = await cancelScheduledTask(task!.id)
      if (!cancelled) {
        return c.json({ error: 'Scheduled task not found or already cancelled' }, 404)
      }
    } else {
      const deleted = await deleteScheduledTask(task!.id)
      if (!deleted) {
        return c.json({ error: 'Scheduled task not found' }, 404)
      }
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to cancel/delete scheduled task:', error)
    return c.json({ error: 'Failed to cancel/delete scheduled task' }, 500)
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

export default scheduledTasksRouter
