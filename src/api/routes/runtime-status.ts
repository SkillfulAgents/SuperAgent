import { getSettings } from '@shared/lib/config/settings'
import { resolveConnectionSelection } from '@shared/lib/llm-provider/connections'
import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { containerHost } from '@shared/lib/agent-actor'
import { APP_VERSION } from '@shared/lib/config/version'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'
import { getServicesInitError } from '@shared/lib/startup'

const runtimeStatus = new Hono()

runtimeStatus.use('*', Authenticated())

// GET /api/runtime-status - lightweight status check for all authenticated users
runtimeStatus.get('/', async (c) => {
  const settings = getSettings()
  const root = settings.llmDefault ? await resolveConnectionSelection(settings.llmDefault) : null
  return c.json({
    runtimeReadiness: containerHost.getReadiness(),
    hasRunningAgents: containerHost.hasRunningAgents(),
    apiKeyConfigured: (root?.provider ?? getActiveLlmProvider()).getApiKeyStatus().isConfigured,
    servicesInitError: getServicesInitError(),
    appVersion: APP_VERSION,
  })
})

export default runtimeStatus
