import type { IntegrationProvider } from '../../agent-integrations/registry'
import { taskManagerPolicy } from '../policy'
import { githubDefinition } from './definition'
import { githubSetup } from './setup'
import { githubAuthorizationInputSchema, githubConfigSchema, parseGitHubConfig } from './config-schema'
import { forgetGitHubToken } from './client'
import type { PublicGitHubIntegration } from './public'

export const githubProvider: IntegrationProvider = {
  definition: githubDefinition, policy: taskManagerPolicy, setup: githubSetup,
  async isAvailable() { const { GitHubAgentIntegration } = await import('./github-agent-integration'); return GitHubAgentIntegration.isAvailable() },
  configuration: {
    identityLabel: 'GitHub App', identityPaths: ['$.app.id'],
    uniqueKey(input) { const parsed = githubConfigSchema.safeParse(input); return parsed.success ? parsed.data.app?.id ?? null : null },
    merge(stored, patch) { githubAuthorizationInputSchema.parse(patch); return parseGitHubConfig(stored) },
  },
  serialize(record): PublicGitHubIntegration {
    const { config: raw, ...fields } = record
    const config = parseGitHubConfig(raw)
    return { ...fields, hasCredentials: !!config.app && !!config.installation && !config.pending && !config.authorizationError,
      authorizationPendingUntil: config.pending?.expiresAt, reconnectRequired: !!config.authorizationError,
      healthMessage: config.authorizationError ?? (config.mcp?.available === false ? 'GitHub tools are temporarily unavailable. Incoming work will retry.' : undefined),
      settings: { account: config.installation?.account, botLogin: config.app ? `${config.app.slug}[bot]` : undefined,
        appName: config.app?.name, appUrl: config.app ? `https://github.com/apps/${config.app.slug}` : undefined } }
  },
  async create(record) { const { GitHubAgentIntegration } = await import('./github-agent-integration'); return new GitHubAgentIntegration(record) },
  async mcp(record) { const { githubMcpConnection } = await import('./mcp'); return githubMcpConnection(record) },
  async cleanup(record) { forgetGitHubToken(record.id) },
  agentDiscovery(record) { const config = parseGitHubConfig(record.config); return { address: config.app ? `${config.app.slug}[bot]` : undefined } },
}
