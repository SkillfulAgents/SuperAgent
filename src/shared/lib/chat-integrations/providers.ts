import type { ZodType } from 'zod'
import type { IntegrationProvider } from '../agent-integrations/registry'
import type { ChatAgentIntegration, ChatConnectorClass } from './chat-agent-integration'
import { telegramConfigSchema, slackConfigSchema, imessageConfigSchema, type ChatProvider } from './config-schema'
import { resolveAppLinkContext, type AppLinkContext } from './utils'
import { chatDefinitions } from './definitions'

type ConnectorConstructor<Config> = ChatConnectorClass & {
  new (config: Config, appLink?: AppLinkContext): ChatAgentIntegration
}

/** Pair each schema with its constructor, keeping transport imports lazy. */
function chatProvider<Config>(
  provider: ChatProvider,
  schema: ZodType<Config>,
  load: () => Promise<ConnectorConstructor<Config>>,
): IntegrationProvider {
  return {
    definition: chatDefinitions[provider],
    async create(record) {
      let config: Config
      try {
        config = schema.parse(JSON.parse(record.config))
      } catch {
        throw new Error(`Invalid config for ${provider} integration ${record.id}`)
      }
      const Connector = await load()
      return new Connector(config, resolveAppLinkContext(record.agentSlug))
    },
    async describeTarget(externalId) {
      const Connector = await load()
      return { type: Connector.classifyChatId?.({ chatId: externalId }) }
    },
  }
}

export const chatProviders: IntegrationProvider[] = [
  chatProvider('telegram', telegramConfigSchema, async () => (await import('./telegram-connector')).TelegramConnector),
  chatProvider('slack', slackConfigSchema, async () => (await import('./slack-connector')).SlackConnector),
  chatProvider('imessage', imessageConfigSchema, async () => (await import('./imessage-connector')).IMessageConnector),
]
