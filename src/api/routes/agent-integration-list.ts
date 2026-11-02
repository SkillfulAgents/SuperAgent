import type { Context } from 'hono'
import { listAgentIntegrations } from '@shared/lib/services/agent-integration-service'
import { toPublicAgentIntegration } from '@shared/lib/agent-integrations/serialization'
import { agentIntegrationManager } from '@shared/lib/agent-integrations/agent-integration-manager'
import { captureException } from '@shared/lib/error-reporting'
import { getAgentId } from '../middleware/auth'

export async function listAgentIntegrationsHandler(c: Context) {
  const agentSlug = getAgentId(c)
  try {
    const rows = await listAgentIntegrations(agentSlug, c.req.query('status') || undefined)
    return c.json(rows.map(row => ({
      ...toPublicAgentIntegration(row), connected: agentIntegrationManager.isIntegrationConnected(row.id),
    })))
  } catch (error) {
    captureException(error, { tags: { component: 'agent-integration', operation: 'list' }, extra: { agentSlug } })
    return c.json({ error: 'Failed to fetch agent integrations' }, 500)
  }
}
