import type { AgentIntegrationRecord } from '../../agent-integrations/types'
import type { IntegrationMcpConnection } from '../../agent-integrations/mcp-types'
import { discoverTools, McpDiscoveryError } from '../../mcp/discover-tools'
import { syncRemoteMcpAgents } from '../../services/connection-sync-service'
import { captureException } from '../../error-reporting'
import { GitHubClient, forgetGitHubToken } from './client'
import { githubToolsSchema, parseGitHubConfig } from './config-schema'
import { readGitHubIntegration, updateGitHubConfig } from './store'

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'
const checking = new Map<string, Promise<boolean>>()

export function githubMcpConnection(record: AgentIntegrationRecord): IntegrationMcpConnection | null {
  const config = parseGitHubConfig(record.config)
  if (!config.app || !config.installation) return null
  const client = new GitHubClient(record.id)
  const version = config.authorizationVersion
  return {
    integrationId: record.id, agentSlug: record.agentSlug, url: GITHUB_MCP_URL,
    identity: { provider: 'GitHub', name: `${config.app.slug}[bot]`, workspace: config.installation.account },
    status: !config.pending && !config.authorizationError && ['active', 'error'].includes(record.status) ? 'active' : 'auth_required',
    tools: config.mcp?.tools ?? [],
    async authorization() {
      return client.authorization({ version, agentSlug: record.agentSlug })
    },
    async authRequired() {
      // A rejected hour-long token alone doesn't prove the app was revoked.
      // Mint again; only GitHub's app/installation API can require reconnect.
      if ((await readGitHubIntegration(record.id)).config.authorizationVersion !== version) return
      forgetGitHubToken(record.id)
      await client.authorization({ version, agentSlug: record.agentSlug })
    },
    async reportHealth(available) {
      const { config: latest } = await readGitHubIntegration(record.id)
      if (latest.authorizationVersion !== version || latest.mcp?.available === available) return
      await updateGitHubConfig(record.id, current => current.authorizationVersion === version
        ? { ...current, mcp: { ...current.mcp, available, checkedAt: Date.now() } } : current)
    },
  }
}

/** Discover on connect and on incoming work; the relay owns retries, not a timer here. */
export async function checkGitHubMcp(id: string): Promise<boolean> {
  const { row, config } = await readGitHubIntegration(id)
  const key = `${id}:${config.authorizationVersion}`
  const existing = checking.get(key)
  if (existing) return existing
  const check = (async () => {
    const connection = githubMcpConnection(row)
    if (!connection || connection.status !== 'active') return false
    if (config.mcp?.available && Date.now() - config.mcp.checkedAt < 300000) return true
    try {
      const tools = githubToolsSchema.parse(await discoverTools(GITHUB_MCP_URL, await connection.authorization(), AbortSignal.timeout(20000)))
      if (!tools.length) throw new Error('GitHub MCP did not return tools')
      await updateGitHubConfig(id, latest => latest.authorizationVersion === config.authorizationVersion
        ? { ...latest, mcp: { available: true, checkedAt: Date.now(), tools } } : latest)
      try { await syncRemoteMcpAgents([row.agentSlug]) }
      catch (error) { captureException(error, { tags: { component: 'github-integration', operation: 'mcp-sync' } }) }
      return (await readGitHubIntegration(id)).config.authorizationVersion === config.authorizationVersion
    } catch (error) {
      if (error instanceof McpDiscoveryError && error.status === 401) await connection.authRequired()
      await connection.reportHealth(false)
      captureException(error, { tags: { component: 'github-integration', operation: 'mcp-discovery' } })
      return false
    }
  })().finally(() => { checking.delete(key) })
  checking.set(key, check)
  return check
}
