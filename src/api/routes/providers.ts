import { Hono } from 'hono'
import { getAllProviders } from '@shared/lib/account-providers'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { Authenticated } from '../middleware/auth'

const providers = new Hono()

providers.use('*', Authenticated())

// GET /api/providers - List the OAuth providers this host can connect
providers.get('/', async (c) => {
  const platformComposio = isPlatformComposioActive()
  const providerList = getAllProviders().filter((p) => !p.platformOnly || platformComposio)
  return c.json({ providers: providerList })
})

export default providers
