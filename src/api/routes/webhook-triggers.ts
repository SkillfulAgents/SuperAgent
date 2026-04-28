/**
 * Webhook Triggers API Routes
 *
 * Endpoints for viewing, cancelling webhook triggers.
 * Note: Listing triggers by agent is in agents.ts under /api/agents/:agentSlug/
 */

import { Hono } from 'hono'
import {
  getWebhookTrigger,
  cancelWebhookTriggerWithCleanup,
  pauseWebhookTrigger,
  resumeWebhookTrigger,
} from '@shared/lib/services/webhook-trigger-service'
import {
  getSessionsByWebhookTrigger,
} from '@shared/lib/services/session-service'
import { messagePersister } from '@shared/lib/container/message-persister'
import { Authenticated, EntityAgentRole } from '../middleware/auth'

const webhookTriggersRouter = new Hono()

webhookTriggersRouter.use('*', Authenticated())

const TriggerAgentRole = EntityAgentRole({
  paramName: 'triggerId',
  lookupFn: getWebhookTrigger,
  contextKey: 'webhookTrigger',
  entityName: 'Webhook trigger',
})

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
    const sessionsWithStatus = sessions.map((session) => ({
      ...session,
      isActive: messagePersister.isSessionActive(session.id),
    }))
    return c.json(sessionsWithStatus)
  } catch (error) {
    console.error('Failed to fetch sessions for webhook trigger:', error)
    return c.json({ error: 'Failed to fetch sessions' }, 500)
  }
})

// POST /api/webhook-triggers/:triggerId/pause - Pause a trigger (events discarded, subscription kept)
webhookTriggersRouter.post('/:triggerId/pause', TriggerAgentRole('user'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>
    const paused = await pauseWebhookTrigger(trigger!.id)
    if (!paused) {
      return c.json({ error: 'Trigger is not active' }, 400)
    }
    const updated = await getWebhookTrigger(trigger!.id)
    return c.json(updated)
  } catch (error) {
    console.error('Failed to pause webhook trigger:', error)
    return c.json({ error: 'Failed to pause webhook trigger' }, 500)
  }
})

// POST /api/webhook-triggers/:triggerId/resume - Resume a paused trigger
webhookTriggersRouter.post('/:triggerId/resume', TriggerAgentRole('user'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>
    const resumed = await resumeWebhookTrigger(trigger!.id)
    if (!resumed) {
      return c.json({ error: 'Trigger is not paused' }, 400)
    }
    const updated = await getWebhookTrigger(trigger!.id)
    return c.json(updated)
  } catch (error) {
    console.error('Failed to resume webhook trigger:', error)
    return c.json({ error: 'Failed to resume webhook trigger' }, 500)
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
