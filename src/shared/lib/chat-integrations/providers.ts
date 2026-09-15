import type { ZodType } from 'zod'
import type { IntegrationProvider } from '../agent-integrations/registry'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import type { ChatAgentIntegration, ChatConnectorClass } from './chat-agent-integration'
import { telegramConfigSchema, slackConfigSchema, imessageConfigSchema, type ChatProvider } from './config-schema'
import { resolveAppLinkContext, type AppLinkContext } from './utils'
import { chatDefinitions } from './definitions'
import { chatIntegrationPolicy } from './chat-policy'

type ConnectorConstructor<Config> = ChatConnectorClass & {
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
): IntegrationProvider {
  return {
    definition: chatDefinitions[provider],
    policy: chatIntegrationPolicy,
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
    async describeTarget(externalId) {
      const Connector = await load()
      return { type: Connector.classifyChatId?.({ chatId: externalId }) }
    },
  }
}

export const chatProviders: IntegrationProvider[] = [
  chatProvider('telegram', telegramConfigSchema, async () => (await import('./telegram-connector')).TelegramConnector),
  chatProvider(
    'slack', slackConfigSchema, async () => (await import('./slack-connector')).SlackConnector,
    async (Connector, config, appLink, record) => {
      const { createSlackThreadStateStore } = await import('./slack-thread-state')
      return new Connector(config, appLink, createSlackThreadStateStore(record.id))
    },
  ),
  chatProvider('imessage', imessageConfigSchema, async () => (await import('./imessage-connector')).IMessageConnector),
]
