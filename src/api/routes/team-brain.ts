import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { teamBrainChoicesSchema } from '@shared/lib/config/team-brain-schema'
import { volumeNameSchema } from '@shared/lib/services/mount-schema'
import { volumeConfigSchema } from '@shared/lib/volumes/volume-config-schema'
import { Authenticated, IsAdmin } from '../middleware/auth'
import { volumeViewer } from '../lib/volume-access'
import { volumeErrorResponse } from '../lib/volume-file'
import { discardSetup, finishSetup, prepareSetup, readSetupView, saveChoices, TeamBrainSetupError, type TeamBrainActor } from '../lib/team-brain-setup'

const setupIdSchema = z.string().min(1)

const prepareBodySchema = z.object({
  setupId: setupIdSchema.nullable(),
  drive: z.object({
    source: volumeConfigSchema,
    details: z.object({ name: z.string().trim().pipe(volumeNameSchema), visibility: z.enum(['private', 'public']) }),
  }),
}).strict()

const choicesBodySchema = teamBrainChoicesSchema.partial().extend({ setupId: setupIdSchema }).strict()

const finishBodySchema = z.object({
  setupId: setupIdSchema,
  setUpBy: z.object({ name: z.string(), email: z.string() }).nullable(),
  accounts: z.array(z.object({ toolkitSlug: z.string(), status: z.string() })).optional(),
}).strict()

const actorOf = (c: Context): TeamBrainActor => ({ c, viewer: volumeViewer(c) })

// Admins set up Team Brain, as they make drives global.
const routes = new Hono()
routes.use('*', Authenticated(), IsAdmin())
routes.onError((error, c) => {
  if (error instanceof TeamBrainSetupError) return c.json({ error: error.message, reason: error.reason, setup: error.setup }, error.status)
  const known = volumeErrorResponse(c, error)
  if (known) return known
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid Team Brain set-up request' }, 400)
  console.error('[team-brain] Set-up request failed:', error)
  return c.json({ error: 'Team Brain set-up failed' }, 500)
})

// GET /api/team-brain/setup - The set-up in progress; 404 with a reason when there is none.
routes.get('/setup', async (c) => c.json(await readSetupView()))

// POST /api/team-brain/setup - Step 1: claim the set-up, then make its agent and drive into it.
routes.post('/setup', async (c) => {
  const body = prepareBodySchema.parse(await c.req.json())
  return c.json({ setup: await prepareSetup(body, actorOf(c)) })
})

// PATCH /api/team-brain/setup - Save the step and choices as they change.
routes.patch('/setup', async (c) => {
  const { setupId, ...changes } = choicesBodySchema.parse(await c.req.json())
  return c.json({ setup: await saveChoices(setupId, changes) })
})

// DELETE /api/team-brain/setup?setupId= - Discard: the agent, the drive, then the set-up.
routes.delete('/setup', async (c) => {
  await discardSetup(setupIdSchema.parse(c.req.query('setupId')), actorOf(c))
  return c.body(null, 204)
})

// POST /api/team-brain/setup/finish - Apply the choices and mark the Team Brain ready.
routes.post('/setup/finish', async (c) => {
  return c.json(await finishSetup(finishBodySchema.parse(await c.req.json()), actorOf(c)))
})

export default routes
