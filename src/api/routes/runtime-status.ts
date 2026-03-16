import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { containerManager } from '@shared/lib/container/container-manager'
import { getActiveLlmProvider } from '@shared/lib/llm-provider'

const runtimeStatus = new Hono()

runtimeStatus.use('*', Authenticated())

// GET /api/runtime-status - lightweight status check for all authenticated users
runtimeStatus.get('/', (c) => {
  return c.json({
    runtimeReadiness: containerManager.getReadiness(),
    hasRunningAgents: containerManager.hasRunningAgents(),
    apiKeyConfigured: getActiveLlmProvider().getApiKeyStatus().isConfigured,
  })
})

export default runtimeStatus
