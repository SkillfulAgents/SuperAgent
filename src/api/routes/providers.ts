import { Hono } from 'hono'
import { getAllProviders } from '@shared/lib/composio/providers'
import { Authenticated } from '../middleware/auth'

const providers = new Hono()

providers.use('*', Authenticated())

// GET /api/providers - List all supported OAuth providers
providers.get('/', async (c) => {
  const providerList = getAllProviders()
  return c.json({ providers: providerList })
})

export default providers
