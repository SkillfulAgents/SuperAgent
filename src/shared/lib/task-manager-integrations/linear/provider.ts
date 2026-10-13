import { linearSetup } from './setup'
import type { IntegrationProvider } from '../../agent-integrations/registry'
import type { PublicLinearIntegration } from './public'
import type { ChatIntegration } from '../../db/schema'
import { taskManagerPolicy } from '../policy'
import { parseTaskJson } from '../schemas'
import { linearConfigSchema, linearSettingsPatchSchema } from './config'
import { IntegrationSetupError } from '../../agent-integrations/setup-types'
import { linearDefinition } from './definition'
import { publicLinearIntegration } from './presentation'

export const linearProvider: IntegrationProvider = {
  definition: linearDefinition, policy: taskManagerPolicy,
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
    const { runOnStatusChange: enabled, webhooks, webhookSecret } = linearSettingsPatchSchema.parse(input.settings ?? input)
    const { updateLinearConfig } = await import('./store')
    const { removeIntegrationWebhooks, setUpIntegrationWebhooks } = await import('../../agent-integrations/relay-transport')
    let reconnect = false
    if (webhooks === true) {
      reconnect = await setUpIntegrationWebhooks(record, linearDefinition, async relay => {
        await updateLinearConfig(record.id, latest => {
          // Another request set them up first; its endpoint must not be overwritten.
          if (latest.relay) throw new IntegrationSetupError('Webhooks are already set up')
          return { ...latest, relay, webhookSecret, webhookSecretStatus: undefined }
        })
      })
    }
    if (webhooks === false) {
      // The secret belongs to the app's webhooks, so it goes with them.
      reconnect = await removeIntegrationWebhooks(record, async () => {
        await updateLinearConfig(record.id, latest => ({ ...latest, relay: undefined, webhookSecret: undefined, webhookSecretStatus: undefined }))
      })
    }
    if (webhookSecret !== undefined && !reconnect) {
      await updateLinearConfig(record.id, latest => ({ ...latest, webhookSecret, webhookSecretStatus: undefined }))
      reconnect = true
    }
    if (enabled !== undefined) await updateLinearConfig(record.id, latest => ({ ...latest, runOnStatusChange: enabled }))
    return { reconnect }
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
