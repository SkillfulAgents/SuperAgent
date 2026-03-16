import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { containerManager } from '@shared/lib/container/container-manager'
import { getAnthropicApiKeyStatus } from '@shared/lib/config/settings'

const runtimeStatus = new Hono()

runtimeStatus.use('*', Authenticated())

// GET /api/runtime-status - lightweight status check for all authenticated users
runtimeStatus.get('/', (c) => {
  return c.json({
    runtimeReadiness: containerManager.getReadiness(),
    hasRunningAgents: containerManager.hasRunningAgents(),
    apiKeyConfigured: getAnthropicApiKeyStatus().isConfigured,
  })
})

export default runtimeStatus
