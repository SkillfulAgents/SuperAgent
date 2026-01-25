import { Hono } from 'hono'
import { getAllProviders } from '@shared/lib/composio/providers'

const providers = new Hono()

// GET /api/providers - List all supported OAuth providers
providers.get('/', async (c) => {
  const providerList = getAllProviders()
  return c.json({ providers: providerList })
})

export default providers
