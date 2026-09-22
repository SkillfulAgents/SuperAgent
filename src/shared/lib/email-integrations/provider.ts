import { platformConnected } from './policy'
import type { IntegrationProvider } from '../agent-integrations/registry'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import { emailIntegrationState } from '../db/schema'
import { emailConfigSchema, emailConfigPatchSchema, parseEmailConfig } from './config-schema'
import { EmailGatewayError } from './gateway-client'
import { provisionEmail, updateEmailMailbox, disableEmailMailbox } from './setup'
import { emailDefinition, emailSessionAllowed, emailSessionPolicy } from './email-agent-integration'

async function setupCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() }
  catch (error) {
    if (error instanceof EmailGatewayError) throw new IntegrationSetupError(error.message, error.status === 403 ? 403 : error.status === 429 ? 429 : 400)
    throw error
  }
}
export const platformEmailProvider: IntegrationProvider = {
  definition: emailDefinition,
  policy: { isAllowed: async context => platformConnected() && await emailSessionAllowed(context), sessionPolicy: emailSessionPolicy },
  storage: () => [emailIntegrationState],
  setup: { async prepare(input, context) { return { config: await setupCall(() => provisionEmail(context.agentSlug, context.userId ?? null, input)) } } },
  configuration: {
    identityLabel: 'Inbox', identityPaths: ['$.mailboxId'],
    uniqueKey(input) { const result = emailConfigSchema.safeParse(input); return result.success ? result.data.mailboxId : null },
    merge: (stored, patch) => emailConfigSchema.parse({ ...parseEmailConfig(stored), ...emailConfigPatchSchema.parse(patch) }),
  },
  serialize(record) {
    const { config, ...fields } = record
    const parsed = parseEmailConfig(config)
    return { ...fields, name: record.name ?? parsed.displayName, hasCredentials: true, settings: { address: parsed.address, displayName: parsed.displayName, localPart: parsed.localPart, accessLevel: parsed.accessLevel, allowedDomains: parsed.allowedDomains } }
  },
  async updateSettings(record, input) {
    if (input.config === undefined && input.name === undefined) return
    const patch = await setupCall(() => updateEmailMailbox(record, input.config, input.name))
    const { updateAgentIntegration } = await import('../services/agent-integration-service')
    await updateAgentIntegration(record.id, { config: patch })
    const { agentIntegrationManager } = await import('../agent-integrations/agent-integration-manager')
    await agentIntegrationManager.reconcileAccess(record.id)
  },
  cleanup: disableEmailMailbox,
  async create(record) { const { PlatformEmailAgentIntegration } = await import('./platform-email-agent-integration'); return new PlatformEmailAgentIntegration(record) },
  async describeTarget() { return { type: 'email-thread' } },
}
