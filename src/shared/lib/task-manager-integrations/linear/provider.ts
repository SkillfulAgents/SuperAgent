import { integrationTaskEvents, linearIssueCursors } from '../../db/schema'
import { linearSetup } from './setup'
import type { IntegrationProvider } from '../../agent-integrations/registry'
import type { PublicLinearIntegration } from './public'
import type { ChatIntegration } from '../../db/schema'
import { taskManagerPolicy } from '../policy'
import { parseTaskJson } from '../schemas'
import { linearConfigSchema, linearSettingsPatchSchema } from './config'
import { linearDefinition } from './definition'
import { publicLinearIntegration } from './presentation'

export const linearProvider: IntegrationProvider = {
  definition: linearDefinition, policy: taskManagerPolicy,
  storage: () => [integrationTaskEvents, linearIssueCursors],
  get setup() { return linearSetup },
  configuration: {
    identityPaths: ['$.identity.workspaceId', '$.identity.appUserId'],
    uniqueKey(input) {
      const parsed = linearConfigSchema.safeParse(input)
      const identity = parsed.success ? parsed.data.identity : undefined
      return identity ? `${identity.workspaceId}:${identity.appUserId}` : null
    },
    merge: (stored, patch) => linearConfigSchema.parse({ ...parseTaskJson(linearConfigSchema, stored), ...patch }),
  },
  serialize(record): PublicLinearIntegration {
    const { config: _config, ...fields } = record
    const linear = publicLinearIntegration(record as ChatIntegration)
    return { ...fields, provider: 'linear', hasCredentials: linear.authorized,
      settings: { runOnStatusChange: linear.runOnStatusChange },
      healthMessage: linear.outbound.message ?? undefined,
      reconnectRequired: linear.authorizationState === 'reconnect_needed',
      authorizationPendingUntil: linear.authorizationPendingUntil, refreshIntervalMs: 30000, linear }
  },
  async updateSettings(record, input) {
    const { runOnStatusChange: enabled } = linearSettingsPatchSchema.parse(input.settings ?? input)
    if (enabled !== undefined) {
      const { updateLinearConfig } = await import('./store')
      await updateLinearConfig(record.id, latest => ({ ...latest, runOnStatusChange: enabled }))
    }
  },
  async mcp(record) {
    const { linearMcpConnection } = await import('./mcp')
    return linearMcpConnection(record)
  },
  async cleanup(record) {
    const { cleanupLinearIntegration } = await import('./setup')
    await cleanupLinearIntegration(record.id)
  },
  async create(record) {
    const { LinearAgentIntegration } = await import('./linear-agent-integration')
    return new LinearAgentIntegration(record)
  },
}
