import { THREAD_NAME_SEPARATOR } from '../agent-integrations/presentation'
import { chatProviderSetup } from './setup'
import { testTeamsCredentials } from './teams-setup'
import { chatIntegrationAccess, chatIntegrationSessions, slackThreadState, teamsCards, teamsConversationReferences } from '../db/schema'
import { z, type ZodType } from 'zod'
import type { IntegrationProvider } from '../agent-integrations/registry'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import type { ChatAgentIntegration, ChatConnectorClass } from './chat-agent-integration'
import { telegramConfigSchema, slackConfigSchema, imessageConfigSchema, teamsConfigSchema, teamsIdentitySchema, type ChatProvider } from './config-schema'
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
    storage: () => [chatIntegrationAccess, chatIntegrationSessions, ...(provider === 'slack' ? [slackThreadState] : []), ...(provider === 'teams' ? [teamsCards, teamsConversationReferences] : [])],
    serialize: record => toPublicChatIntegration(record as ChatIntegration),
    configuration: {
      identityLabel: provider === 'teams' ? 'Teams app' : provider === 'imessage' ? 'Phone number' : 'Bot token',
      identityPaths: provider === 'teams' ? ['$.tenantId', '$.appId'] : [`$.${identityField}`],
      uniqueKey(input) {
        if (provider === 'teams') {
          const identity = teamsIdentitySchema.safeParse(input)
          return identity.success ? `${identity.data.tenantId}:${identity.data.appId}` : null
        }
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
      const appLink = await resolveAppLinkContext(record.agentSlug)
      return instantiate ? instantiate(Connector, config, appLink, record) : new Connector(config, appLink)
    },
    cleanup,
    updateSettings,
    async describeTarget(externalId) {
      const Connector = await load()
      return { type: Connector.classifyChatId?.({ chatId: externalId }) }
    },
    async conversationOf(externalId, displayName) {
      const parent = (await load()).parentChatId?.(externalId)
      if (!parent) return { externalId, displayName }
      // A thread's name is its channel's name with the thread's start time after it.
      const cut = displayName?.lastIndexOf(THREAD_NAME_SEPARATOR) ?? -1
      return { externalId: parent, displayName: cut > 0 ? displayName!.slice(0, cut) : null }
    },
  }
}

export const chatProviders: IntegrationProvider[] = [
  chatProvider(
    'teams', teamsConfigSchema, async () => (await import('./teams-connector')).TeamsConnector,
    (Connector, config, appLink, record) => new Connector(config, appLink, record),
    undefined,
    async (record, input) => {
      if (!input.config) return
      const next = teamsConfigSchema.parse(mergeChatIntegrationConfig('teams', record.config, input.config))
      const previous = parseChatIntegrationConfig('teams', record.config)
      if (!previous || !('clientSecret' in previous) || next.clientSecret !== previous.clientSecret) {
        await testTeamsCredentials(next)
      }
    },
  ),
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
