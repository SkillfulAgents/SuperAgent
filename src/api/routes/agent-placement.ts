import { Hono } from 'hono'
import { z } from 'zod'
import { AgentAdmin, AgentRead, ResolveAgent, getAgentId } from '../middleware/auth'
import {
  AgentAlreadyOnModalError,
  agentRegistry,
  moveAgentToModal,
  readAgentPlacement,
} from '@shared/lib/agent-actor'

/**
 * Where an agent runs: on this machine, or in a Modal sandbox with its
 * workspace on a Modal volume. Reading is open to anyone who can read the
 * agent; moving it is an admin action, and today the only move is to Modal.
 * Mounted into the `agents` router at the `/api/agents` root.
 */
export const agentPlacementRoutes = new Hono()

const movePlacementSchema = z.object({
  runtime: z.literal('modal'),
})

agentPlacementRoutes.get('/:id/placement', ResolveAgent(), AgentRead(), async (c) => {
  return c.json(readAgentPlacement(getAgentId(c)))
})

agentPlacementRoutes.put('/:id/placement', ResolveAgent(), AgentAdmin(), async (c) => {
  const parsed = movePlacementSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'Only { "runtime": "modal" } is supported' }, 400)
  }
  const slug = getAgentId(c)
  try {
    const result = await moveAgentToModal(slug, agentRegistry)
    return c.json(result)
  } catch (error) {
    if (error instanceof AgentAlreadyOnModalError) {
      return c.json({ placement: readAgentPlacement(slug), filesUploaded: 0, bytesUploaded: 0 })
    }
    console.error(`Failed to move agent ${slug} to Modal:`, error)
    return c.json({ error: error instanceof Error ? error.message : 'Failed to move the agent to Modal' }, 500)
  }
})
