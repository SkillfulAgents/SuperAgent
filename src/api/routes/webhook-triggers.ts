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
  updateWebhookTriggerPrompt,
  updateWebhookTriggerRuntimeOptions,
} from '@shared/lib/services/webhook-trigger-service'
import { promptUpdateSchema } from './trigger-prompt-schema'
import { RuntimeOptionsPatchSchema } from '@shared/lib/container/runtime-options'
import {
  getSessionsByWebhookTrigger,
} from '@shared/lib/services/session-service'
import { messagePersister } from '@shared/lib/container/message-persister'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { toPublicWebhookTrigger } from '@shared/lib/webhook-triggers/public'
import { Authenticated, EntityAgentRole, getAuthorizedAgentRole } from '../middleware/auth'

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
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>
    return c.json(toPublicWebhookTrigger(trigger!, getAuthorizedAgentRole(c)))
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
    if (!updated) throw new Error('Webhook trigger disappeared after pause')
    logAuditEvent({ userId: getCurrentUserId(c), object: 'trigger', objectId: trigger!.id, action: 'paused' })
    return c.json(toPublicWebhookTrigger(updated, getAuthorizedAgentRole(c)))
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
    if (!updated) throw new Error('Webhook trigger disappeared after resume')
    logAuditEvent({ userId: getCurrentUserId(c), object: 'trigger', objectId: trigger!.id, action: 'resumed' })
    return c.json(toPublicWebhookTrigger(updated, getAuthorizedAgentRole(c)))
  } catch (error) {
    console.error('Failed to resume webhook trigger:', error)
    return c.json({ error: 'Failed to resume webhook trigger' }, 500)
  }
})

// PATCH /api/webhook-triggers/:triggerId/prompt - Edit the trigger's instructions
webhookTriggersRouter.patch('/:triggerId/prompt', TriggerAgentRole('user'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>
    const body = await c.req.json().catch(() => ({}))
    const parsed = promptUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid prompt' }, 400)
    }

    const updated = await updateWebhookTriggerPrompt(trigger!.id, parsed.data.prompt)
    if (!updated) {
      return c.json({ error: 'Trigger not found or cancelled' }, 404)
    }

    const refreshed = await getWebhookTrigger(trigger!.id)
    if (!refreshed) throw new Error('Webhook trigger disappeared after prompt update')
    logAuditEvent({ userId: getCurrentUserId(c), object: 'trigger', objectId: trigger!.id, action: 'updated', details: { field: 'prompt' } })
    return c.json(toPublicWebhookTrigger(refreshed, getAuthorizedAgentRole(c)))
  } catch (error) {
    console.error('Failed to update webhook trigger prompt:', error)
    return c.json({ error: 'Failed to update prompt' }, 500)
  }
})

// PATCH /api/webhook-triggers/:triggerId/runtime-options - Update model, effort, and/or speed
webhookTriggersRouter.patch('/:triggerId/runtime-options', TriggerAgentRole('user'), async (c) => {
  try {
    const trigger = c.get('webhookTrigger' as never) as Awaited<ReturnType<typeof getWebhookTrigger>>
    const body = await c.req.json().catch(() => ({}))
    const parsed = RuntimeOptionsPatchSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid runtime options' }, 400)
    }

    const updates: { model?: string | null; effort?: string | null; speed?: string | null } = {}
    if ('model' in body) updates.model = parsed.data.model ?? null
    if ('effort' in body) updates.effort = parsed.data.effort ?? null
    if ('speed' in body) updates.speed = parsed.data.speed ?? null

    const updated = await updateWebhookTriggerRuntimeOptions(trigger!.id, updates)
    if (!updated) {
      return c.json({ error: 'Trigger not found or cancelled' }, 404)
    }

    const refreshed = await getWebhookTrigger(trigger!.id)
    if (!refreshed) throw new Error('Webhook trigger disappeared after runtime options update')
    logAuditEvent({ userId: getCurrentUserId(c), object: 'trigger', objectId: trigger!.id, action: 'updated', details: { field: 'runtime-options' } })
    return c.json(toPublicWebhookTrigger(refreshed, getAuthorizedAgentRole(c)))
  } catch (error) {
    console.error('Failed to update webhook trigger runtime options:', error)
    return c.json({ error: 'Failed to update runtime options' }, 500)
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

    logAuditEvent({ userId: getCurrentUserId(c), object: 'trigger', objectId: trigger!.id, action: 'deleted' })

    return c.body(null, 204)
  } catch (error) {
    console.error('Failed to cancel webhook trigger:', error)
    return c.json({ error: 'Failed to cancel webhook trigger' }, 500)
  }
})

export default webhookTriggersRouter
