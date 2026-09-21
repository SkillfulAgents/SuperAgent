import type { AgentIntegrationRecord } from '../../agent-integrations/types'
import type { IntegrationMcpConnection } from '../../agent-integrations/mcp-types'
import { getIntegration } from '../../agent-integrations/store'
import { discoverTools, McpDiscoveryError } from '../../mcp/discover-tools'
import { syncRemoteMcpAgents } from '../../services/connection-sync-service'
import { getLinearConfig, updateLinearConfig, revokeLinearAuthorization } from './store'
import { LinearClient } from './client'
import { linearConfigSchema, linearMcpToolsSchema } from './config'
import { captureException } from '../../error-reporting'
import { parseTaskJson } from '../schemas'

export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp'
const checking = new Map<string, Promise<boolean>>()

async function sync(id: string): Promise<void> {
  const row = await getIntegration(id)
  if (row) {
    try { await syncRemoteMcpAgents([row.agentSlug]) }
    catch (error) { captureException(error, { tags: { component: 'linear-mcp', operation: 'runtime-sync' } }) }
  }
}
async function health(id: string, version: string | undefined, available: boolean): Promise<void> {
  const config = await getLinearConfig(id)
  if (config.authorizationVersion !== version || config.mcp?.available === available) return
  await updateLinearConfig(id, latest => latest.authorizationVersion === version
    ? { ...latest, mcp: { ...latest.mcp, available, checkedAt: Date.now() } } : latest)
}

export async function linearMcpConnection(record: AgentIntegrationRecord): Promise<IntegrationMcpConnection | null> {
  const config = parseTaskJson(linearConfigSchema, record.config)
  if (!config.identity) return null
  const version = config.authorizationVersion
  let usedToken: string | undefined
  return {
    integrationId: record.id, agentSlug: record.agentSlug, url: LINEAR_MCP_URL,
    identity: { provider: 'Linear', name: config.identity.appName, workspace: config.identity.workspaceName },
    status: config.tokens && !config.authorizationPending && !config.authorizationError ? 'active' : 'auth_required',
    tools: config.mcp?.tools ?? [],
    async authorization() {
      const current = await getIntegration(record.id)
      if (!current || current.agentSlug !== record.agentSlug || !['active', 'error'].includes(current.status)) throw new Error('This agent integration is not active')
      const latest = await getLinearConfig(record.id)
      if (latest.authorizationVersion !== version) throw new Error('Integration authorization changed. Retry through the reconnected integration.')
      usedToken = (await new LinearClient(record.id).authorization()).accessToken
      const after = await getIntegration(record.id)
      if (!after || !['active', 'error'].includes(after.status) || (await getLinearConfig(record.id)).authorizationVersion !== version) throw new Error('This agent integration is not active')
      return usedToken
    },
    async authRequired() {
      if (usedToken) await revokeLinearAuthorization(record.id, { accessToken: usedToken, authorizationVersion: version })
      await sync(record.id)
    },
    reportHealth: available => health(record.id, version, available),
  }
}

/** Probe discovery on boot and at most every five minutes while healthy. Failed
 * probes retry at the inbound polling cadence; accepted work stays queued. */
export async function checkLinearMcp(id: string): Promise<boolean> {
  const existing = checking.get(id)
  if (existing) return existing
  const check = (async () => {
    const record = await getIntegration(id)
    if (!record || !['active', 'error'].includes(record.status)) return false
    const config = await getLinearConfig(id)
    if (!config.tokens || config.authorizationPending || config.authorizationError) return false
    if (config.mcp?.available && Date.now() - config.mcp.checkedAt < 300000) return true
    const connection = await linearMcpConnection(record)
    if (!connection) return false
    try {
      const tools = linearMcpToolsSchema.parse(await discoverTools(LINEAR_MCP_URL, await connection.authorization(), AbortSignal.timeout(20000)))
      if (!tools.length) throw new Error('Linear MCP did not return any tools')
      await updateLinearConfig(id, latest => latest.authorizationVersion === config.authorizationVersion
        ? { ...latest, mcp: { available: true, checkedAt: Date.now(), tools } } : latest)
      await sync(id)
      return (await getLinearConfig(id)).authorizationVersion === config.authorizationVersion
    } catch (error) {
      if (error instanceof McpDiscoveryError && error.status === 401) await connection.authRequired()
      await health(id, config.authorizationVersion, false)
      return false
    }
  })().finally(() => { checking.delete(id) })
  checking.set(id, check)
  return check
}
