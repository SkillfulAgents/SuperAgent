import { Hono } from 'hono'
import { z } from 'zod'
import { TEAM_BRAIN_LOCATION_IDS, teamBrainChoicesSchema } from '@shared/lib/config/team-brain-schema'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { claimSetup, dropSetup, markReady, readSetupView, saveSetup, TeamBrainSetupError } from '../lib/team-brain-setup'

const setupIdSchema = z.string().min(1)

const saveBodySchema = teamBrainChoicesSchema.partial().extend({
  setupId: setupIdSchema,
  agent: z.object({ slug: z.string().min(1).nullable(), replaces: z.string().nullable() }).strict().optional(),
  drive: z.object({
    volumeId: z.string().min(1).nullable(),
    location: z.enum(TEAM_BRAIN_LOCATION_IDS).nullable(),
    replaces: z.string().nullable(),
  }).strict().optional(),
}).strict()

const setupIdBodySchema = z.object({ setupId: setupIdSchema }).strict()

// Admins set up Team Brain, as they make drives global. The set-up itself runs through the app's own routes; these
// hold its claim (see team-brain-setup.ts).
const routes = new Hono()
routes.use('*', Authenticated(), IsAdmin())
routes.onError((error, c) => {
  if (error instanceof TeamBrainSetupError) return c.json({ error: error.message, reason: error.reason }, error.status)
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid Team Brain set-up request' }, 400)
  console.error('[team-brain] Set-up request failed:', error)
  return c.json({ error: 'Team Brain set-up failed' }, 500)
})

// GET /api/team-brain/setup - The set-up in progress and what of it is still there; 404 when there is none.
routes.get('/setup', async (c) => c.json(await readSetupView()))

// POST /api/team-brain/setup - Claim the workspace's one set-up, before anything is made for it.
routes.post('/setup', async (c) => c.json(await claimSetup(), 201))

// PATCH /api/team-brain/setup - Record the agent or drive just made or about to be removed, and the choices.
routes.patch('/setup', async (c) => {
  const { setupId, ...changes } = saveBodySchema.parse(await c.req.json())
  return c.json(await saveSetup(setupId, changes))
})

// DELETE /api/team-brain/setup?setupId= - Discard: drop the claim and answer the agent and drive for the page to remove.
routes.delete('/setup', async (c) => c.json(await dropSetup(setupIdSchema.parse(c.req.query('setupId')))))

// POST /api/team-brain/setup/ready - Start chat's last call: the set-up becomes the Team Brain and members get it.
routes.post('/setup/ready', async (c) => {
  const { setupId } = setupIdBodySchema.parse(await c.req.json())
  return c.json(await markReady(setupId))
})

export default routes
