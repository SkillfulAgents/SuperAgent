import { resolveGlobalSelection } from '@shared/lib/llm-provider/connections'
import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { containerHost } from '@shared/lib/agent-actor'
import { APP_VERSION } from '@shared/lib/config/version'
import { activeLlmProviderFrom } from '@shared/lib/llm-provider'
import { getSettings } from '@shared/lib/config/settings'
import { getServicesInitError } from '@shared/lib/startup'

const runtimeStatus = new Hono()

runtimeStatus.use('*', Authenticated())

// GET /api/runtime-status - lightweight status check for all authenticated users.
// Polled by every window, so one settings read answers it.
runtimeStatus.get('/', async (c) => {
  const settings = await getSettings()
  const root = await resolveGlobalSelection(undefined, settings)
  return c.json({
    runtimeReadiness: containerHost.getReadiness(),
    hasRunningAgents: containerHost.hasRunningAgents(),
    apiKeyConfigured: (root?.provider ?? activeLlmProviderFrom(settings)).apiKeyStatusFrom(settings).isConfigured,
    servicesInitError: getServicesInitError(),
    appVersion: APP_VERSION,
  })
})

export default runtimeStatus
