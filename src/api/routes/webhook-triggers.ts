/**
 * Webhook Triggers API Routes
 *
 * Endpoints for viewing, cancelling webhook triggers.
 * Note: Listing triggers by agent is in agents.ts under /api/agents/:agentSlug/
 */

import { Hono } from 'hono'
import type { Context, Next, MiddlewareHandler } from 'hono'
import { eq, and } from 'drizzle-orm'
import {
  getWebhookTrigger,
  cancelWebhookTriggerWithCleanup,
} from '@shared/lib/services/webhook-trigger-service'
import {
  getSessionsByWebhookTrigger,
} from '@shared/lib/services/session-service'
import { Authenticated, type AgentRole, ROLE_HIERARCHY } from '../middleware/auth'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { db } from '@shared/lib/db'
import { agentAcl } from '@shared/lib/db/schema'

const webhookTriggersRouter = new Hono()

webhookTriggersRouter.use('*', Authenticated())

function TriggerAgentRole(minRole: AgentRole): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const triggerId = c.req.param('triggerId')!
    const trigger = await getWebhookTrigger(triggerId)
    if (!trigger) {
      return c.json({ error: 'Webhook trigger not found' }, 404)
    }
    c.set('webhookTrigger' as never, trigger as never)

    if (!isAuthMode()) return next()

    const userId = getCurrentUserId(c)
    const [row] = await db
      .select({ role: agentAcl.role })
      .from(agentAcl)
      .where(and(eq(agentAcl.userId, userId), eq(agentAcl.agentSlug, trigger.agentSlug)))
      .limit(1)

    const userRole = (row?.role as AgentRole) ?? null
    if (!userRole || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minRole]) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  }
}

// GET /api/webhook-triggers/:triggerId - Get a single trigger
webhookTriggersRouter.get('/:triggerId', TriggerAgentRole('viewer'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never)
    return c.json(trigger)
  } catch (error) {
    console.error('Failed to fetch webhook trigger:', error)
    return c.json({ error: 'Failed to fetch webhook trigger' }, 500)
  }
})

// GET /api/webhook-triggers/:triggerId/sessions - Get sessions created by this trigger
webhookTriggersRouter.get('/:triggerId/sessions', TriggerAgentRole('viewer'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>
    const sessions = await getSessionsByWebhookTrigger(trigger!.agentSlug, trigger!.id)
    return c.json(sessions)
  } catch (error) {
    console.error('Failed to fetch sessions for webhook trigger:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// DELETE /api/webhook-triggers/:triggerId - Cancel a trigger (dual: SQLite + Composio)
webhookTriggersRouter.delete('/:triggerId', TriggerAgentRole('user'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>

    const cancelled = await cancelWebhookTriggerWithCleanup(trigger!.id)
    if (!cancelled) {
      return c.json({ error: 'Webhook trigger not found or already cancelled' }, 404)
    }

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to cancel webhook trigger:', error)
    return c.json({ error: 'Failed to cancel webhook trigger' }, 500)
  }
})

export default webhookTriggersRouter
