import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { Authenticated } from '../middleware/auth'
import {
  BrainCuratorNotFoundError,
  getCuratorSlug,
  isTeamBrainEnabled,
  setCuratorSlug,
} from '@shared/lib/services/brain-service'
import { curatorResponseSchema, curatorSlugSchema } from '@shared/lib/types/brain-schema'

const brainAdmin = new Hono()

brainAdmin.use('*', Authenticated())

brainAdmin.get('/curator', (c) => {
  if (!isTeamBrainEnabled()) {
    return c.json(curatorResponseSchema.parse({ enabled: false, agentSlug: null }))
  }
  return c.json(curatorResponseSchema.parse({ enabled: true, agentSlug: getCuratorSlug() }))
})

brainAdmin.put('/curator', zValidator('json', curatorSlugSchema), async (c) => {
  if (!isTeamBrainEnabled()) return c.json({ error: 'Team Brain is off' }, 404)
  try {
    const agentSlug = await setCuratorSlug(c.req.valid('json').agentSlug)
    return c.json(curatorResponseSchema.parse({ enabled: true, agentSlug }))
  } catch (err) {
    if (err instanceof BrainCuratorNotFoundError) return c.json({ error: err.message }, 404)
    throw err
  }
})

export default brainAdmin
