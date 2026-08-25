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
import { containerManager } from '@shared/lib/container/container-manager'

const brainAdmin = new Hono()

brainAdmin.use('*', Authenticated())

async function restartIfRunning(slug: string): Promise<void> {
  if (containerManager.getCachedInfo(slug).status === 'running') {
    await containerManager.restartContainer(slug)
  }
}

brainAdmin.get('/curator', (c) => {
  if (!isTeamBrainEnabled()) {
    return c.json(curatorResponseSchema.parse({ enabled: false, agentSlug: null }))
  }
  return c.json(curatorResponseSchema.parse({ enabled: true, agentSlug: getCuratorSlug() }))
})

brainAdmin.put('/curator', zValidator('json', curatorSlugSchema), async (c) => {
  if (!isTeamBrainEnabled()) return c.json({ error: 'Team Brain is off' }, 404)
  const next = c.req.valid('json').agentSlug
  const previous = getCuratorSlug()
  try {
    // The mount attaches at container start, so a curator change is a restart.
    // Stop the previous curator before the pointer moves: a failed stop must
    // not leave two containers holding the folder read/write.
    if (previous && previous !== next) {
      // Always stop, even if the cache says the old curator is already down.
      // A failed earlier stop still marks the cache stopped while the container
      // can be running. Retrying must not skip the stop and leave two writers.
      await containerManager.stopContainer(previous)
    }
    const agentSlug = await setCuratorSlug(next)
    if (agentSlug) await restartIfRunning(agentSlug)
    return c.json(curatorResponseSchema.parse({ enabled: true, agentSlug }))
  } catch (err) {
    if (err instanceof BrainCuratorNotFoundError) return c.json({ error: err.message }, 404)
    throw err
  }
})

export default brainAdmin
