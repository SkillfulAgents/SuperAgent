import { Hono } from 'hono'
import { ZodError } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { IsAgent } from '../middleware/auth'
import {
  BrainIndexProtectedError,
  BrainPageTooLargeError,
  deletePage,
  getCuratorSlug,
  isTeamBrainEnabled,
  readPage,
  writePage,
} from '@shared/lib/services/brain-service'
import {
  brainCuratorLookupSchema,
  brainWriteBodySchema,
  brainWriteResponseSchema,
  pageReadResponseSchema,
  pageReadSchema,
} from '@shared/lib/types/brain-schema'

const brainAgent = new Hono()

brainAgent.use('*', IsAgent())

brainAgent.use('*', async (c, next) => {
  if (!isTeamBrainEnabled()) return c.json({ error: 'Team Brain is off' }, 404)
  return next()
})

function callerSlug(c: { get: (k: never) => unknown }): string {
  return c.get('agentSlug' as never) as string
}

brainAgent.get('/curator', (c) => {
  return c.json(brainCuratorLookupSchema.parse({ agentSlug: getCuratorSlug() }))
})

brainAgent.post('/read', zValidator('json', pageReadSchema), (c) => {
  try {
    const page = readPage(c.req.valid('json').name)
    if (!page) return c.json(pageReadResponseSchema.parse({ found: false, suggestions: [] }))
    return c.json(pageReadResponseSchema.parse({ found: true, ...page }))
  } catch (err) {
    if (err instanceof BrainPageTooLargeError) return c.json({ error: err.message }, 413)
    throw err
  }
})

brainAgent.post('/write', zValidator('json', brainWriteBodySchema), async (c) => {
  const body = c.req.valid('json')
  const curator = getCuratorSlug()
  if (!curator) return c.json({ error: 'No curator' }, 409)
  if (callerSlug(c) !== curator) return c.json({ error: 'Only the curator can persist' }, 403)
  if (!body.name) return c.json({ error: 'Curator must write or delete a named page' }, 400)

  try {
    if (body.delete) {
      const deleted = deletePage(body.name)
      if (!deleted) return c.json({ error: 'Page not found' }, 404)
      return c.json(brainWriteResponseSchema.parse({ status: 'deleted', name: deleted.name }))
    }
    const wrote = writePage(body.name, body.body ?? '')
    return c.json(brainWriteResponseSchema.parse({
      status: 'wrote',
      name: wrote.name,
      updatedAt: wrote.updatedAt,
    }))
  } catch (err) {
    if (err instanceof BrainIndexProtectedError) return c.json({ error: err.message }, 400)
    if (err instanceof BrainPageTooLargeError) return c.json({ error: err.message }, 413)
    if (err instanceof ZodError) return c.json({ error: 'invalid page name' }, 400)
    throw err
  }
})

export default brainAgent
