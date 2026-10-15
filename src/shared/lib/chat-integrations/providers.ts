import { chatProviderSetup } from './setup'
import { chatIntegrationAccess, chatIntegrationSessions, slackThreadState } from '../db/schema'
import { z, type ZodType } from 'zod'
import type { IntegrationProvider } from '../agent-integrations/registry'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import type { ChatAgentIntegration, ChatConnectorClass } from './chat-agent-integration'
import { telegramConfigSchema, slackConfigSchema, imessageConfigSchema, type ChatProvider } from './config-schema'
import { resolveAppLinkContext, type AppLinkContext } from '@shared/lib/agent-integrations/app-link'
import { toPublicChatIntegration } from './public'
import { mergeChatIntegrationConfig, parseChatIntegrationConfig, type IMessageConfig, type TelegramConfig } from './config-schema'
import type { ChatIntegration } from '../db/schema'
import { chatDefinitions } from './definitions'
import { chatIntegrationPolicy } from './chat-policy'

type ConnectorConstructor<Config> = ChatConnectorClass & {
  isAvailable(): boolean | Promise<boolean>
  new (config: Config, appLink?: AppLinkContext): ChatAgentIntegration
}

/** Pair each schema with its constructor, keeping transport imports lazy. */
function chatProvider<Config, Connector extends ConnectorConstructor<Config>>(
  provider: ChatProvider,
  schema: ZodType<Config>,
  load: () => Promise<Connector>,
  instantiate?: (
    Connector: Connector,
    config: Config,
    appLink: AppLinkContext,
    record: AgentIntegrationRecord,
  ) => ChatAgentIntegration | Promise<ChatAgentIntegration>,
  cleanup?: IntegrationProvider['cleanup'],
  updateSettings?: IntegrationProvider['updateSettings'],
): IntegrationProvider {
  const identityField = provider === 'imessage' ? 'phoneNumber' : 'botToken'
  const identitySchema = z.object({ [identityField]: z.string().min(1) })
  return {
    definition: chatDefinitions[provider],
    async isAvailable() { return (await load()).isAvailable() },
    policy: chatIntegrationPolicy,
    setup: chatProviderSetup(provider, schema),
    storage: () => [chatIntegrationAccess, chatIntegrationSessions, ...(provider === 'slack' ? [slackThreadState] : [])],
    serialize: record => toPublicChatIntegration(record as ChatIntegration),
    configuration: {
      identityLabel: provider === 'imessage' ? 'Phone number' : 'Bot token',
      identityPaths: [`$.${identityField}`],
      uniqueKey(input) {
        const parsed = identitySchema.safeParse(input)
        return parsed.success ? parsed.data[identityField] : null
      },
      merge: (stored, patch) => mergeChatIntegrationConfig(provider, stored, patch),
    },
    async create(record) {
      let config: Config
      try {
        config = schema.parse(JSON.parse(record.config))
      } catch {
        throw new Error(`Invalid config for ${provider} integration ${record.id}`)
      }
      const Connector = await load()
      const appLink = resolveAppLinkContext(record.agentSlug)
      return instantiate ? instantiate(Connector, config, appLink, record) : new Connector(config, appLink)
    },
    cleanup,
    updateSettings,
    async describeTarget(externalId) {
      const Connector = await load()
      return { type: Connector.classifyChatId?.({ chatId: externalId }) }
    },
  }
}

export const chatProviders: IntegrationProvider[] = [
  chatProvider(
    'telegram', telegramConfigSchema, async () => (await import('./telegram-connector')).TelegramConnector,
    (Connector, config, appLink, record) => new Connector(config, appLink, record),
    async record => {
      (await import('./telegram-connector')).forgetTelegramInstallation(record.id)
      // The bot stops posting to the endpoint, which is disabled after this.
      const config = parseChatIntegrationConfig('telegram', record.config) as TelegramConfig | null
      if (!config?.relay) return
      const { deleteTelegramWebhook } = await import('./telegram-webhooks')
      await deleteTelegramWebhook(config)
    },
  ),
  chatProvider(
    'slack', slackConfigSchema, async () => (await import('./slack-connector')).SlackConnector,
    async (Connector, config, appLink, record) => {
      const { createSlackThreadStateStore } = await import('./slack-thread-state')
      return new Connector(config, appLink, createSlackThreadStateStore(record.id), record)
    },
    // The app keeps posting to the endpoint, which is disabled after this.
    async record => { (await import('./slack-connector')).forgetSlackInstallation(record.id) },
    async (record, input) => (await import('./slack-webhooks')).updateSlackWebhookSettings(record, input),
  ),
  chatProvider(
    'imessage', imessageConfigSchema, async () => (await import('./imessage-connector')).IMessageConnector,
    (Connector, config, appLink, record) => new Connector(config, appLink, record),
    async record => {
      // The gateway holds events for the socket again; the endpoint itself is disabled after this.
      const config = parseChatIntegrationConfig('imessage', record.config) as IMessageConfig | null
      if (!config?.relay) return
      const { deleteGatewayWebhook } = await import('./imessage-gateway-client')
      await deleteGatewayWebhook(config)
    },
  ),
]
