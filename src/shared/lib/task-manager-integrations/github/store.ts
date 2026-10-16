import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { chatIntegrations, integrationDeliveries } from '../../db/schema'
import { requireIntegrationReconnect } from '../../agent-integrations/lifecycle'
import { githubConfigSchema, parseGitHubConfig, type GitHubConfig } from './config-schema'

export async function readGitHubIntegration(id: string) {
  const row = await db.select().from(chatIntegrations).where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, 'github'))).get()
  if (!row) throw new Error('GitHub integration not found')
  return { row, config: parseGitHubConfig(row.config) }
}

/** Conditional writes keep callbacks, reconnects and settings from overwriting one another. */
export async function updateGitHubConfig(id: string, update: (config: GitHubConfig) => GitHubConfig): Promise<GitHubConfig> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { row, config } = await readGitHubIntegration(id)
    const next = githubConfigSchema.parse(update(config))
    const unique = next.app ? sql`not exists (select 1 from ${chatIntegrations} as other where other.id <> ${id} and other.provider = 'github'
      and json_extract(case when json_valid(other.config) then other.config else '{}' end, '$.app.id') = ${next.app.id})` : undefined
    const changed = await db.update(chatIntegrations).set({ config: JSON.stringify(next), updatedAt: new Date() })
      .where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.config, row.config), unique)).returning({ id: chatIntegrations.id }).get()
    if (changed) return next
  }
  throw new Error('GitHub configuration changed or this app already belongs to another integration. Try again with a separate app for each agent.')
}

export async function revokeGitHubAuthorization(id: string, version: string | undefined): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { row, config } = await readGitHubIntegration(id)
    if (config.authorizationVersion !== version || config.pending || config.authorizationError) return
    const message = 'GitHub access was removed or suspended. Reconnect this integration.'
    if (await requireIntegrationReconnect({ integrationId: id, expectedConfig: row.config,
      config: githubConfigSchema.parse({ ...config, authorizationError: message, mcp: undefined }), message })) return
  }
}

/** The first input may be accepted before the manager creates its session mapping. */
export async function hasPendingGitHubInput(integrationId: string, taskId: string): Promise<boolean> {
  return !!await db.select({ id: integrationDeliveries.id }).from(integrationDeliveries)
    .where(and(eq(integrationDeliveries.integrationId, integrationId), eq(integrationDeliveries.externalId, taskId),
      inArray(integrationDeliveries.state, ['pending', 'preparing', 'sending']))).limit(1).get()
}
