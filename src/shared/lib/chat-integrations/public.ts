import type { PublicAgentIntegration } from '../agent-integrations/public'
import type { ChatIntegration } from '@shared/lib/db/schema'
import {
  parseChatIntegrationConfig,
  CHAT_PROVIDERS,
  type ChatProvider,
  type SlackConfig,
  type TelegramConfig,
} from './config-schema'

/**
 * Non-secret provider settings that the renderer may read back and edit.
 * Credential-bearing and identifying config fields intentionally have no
 * representation in the public API contract.
 */
export interface PublicChatIntegrationSettings {
  richMessages?: boolean
  draftStreaming?: boolean
  skipEntityDetection?: boolean
  onlyMentioned?: boolean
  answerInThread?: boolean
  newSessionPerThread?: boolean
}

/**
 * How a Slack app reaches the installation. `webhook` is set once webhooks
 * are: the URL its Event Subscriptions and Interactivity post to, and whether
 * a post has verified with the saved signing secret (`pending` until one has).
 */
export interface PublicSlackDelivery {
  botTokenSaved: boolean
  appTokenSaved: boolean
  signingSecretSaved: boolean
  webhook: { url: string; status: 'pending' | 'verified' | 'rejected' } | null
}

export type PublicChatIntegration = PublicAgentIntegration<PublicChatIntegrationSettings>
  & Pick<ChatIntegration, 'showToolCalls' | 'requireApproval' | 'sessionTimeout'>
  & { provider: ChatProvider; slack?: PublicSlackDelivery }

/** Slack's delivery state, for an integration that is a Slack one. */
export function publicSlackDelivery(integration: PublicAgentIntegration): PublicSlackDelivery | undefined {
  return isPublicChatIntegration(integration) ? integration.slack : undefined
}

/** Narrow an already-serialized integration to the chat family's public contract. */
export function isPublicChatIntegration(integration: PublicAgentIntegration): integration is PublicChatIntegration {
  return CHAT_PROVIDERS.some(provider => provider === integration.provider)
}

/**
 * Convert the internal credential-bearing DB row into its API-safe form.
 * Keep this as the only serialization boundary for chat integrations: callers
 * inside the process still receive the full row needed by connectors.
 */
export function toPublicChatIntegration(integration: ChatIntegration): PublicChatIntegration {
  if (!CHAT_PROVIDERS.some(provider => provider === integration.provider)) throw new Error('Use the agent integration API for this provider')
  const { config, provider, ...publicFields } = integration
  const parsed = typeof config === 'string'
    ? parseChatIntegrationConfig(provider as ChatProvider, config)
    : null

  const settings: PublicChatIntegrationSettings = {}
  if (parsed && integration.provider === 'telegram') {
    const telegram = parsed as TelegramConfig
    settings.richMessages = telegram.richMessages
    settings.draftStreaming = telegram.draftStreaming
    settings.skipEntityDetection = telegram.skipEntityDetection
  }
  const slack = parsed && integration.provider === 'slack' ? parsed as SlackConfig : null
  if (slack) {
    settings.onlyMentioned = slack.onlyMentioned
    settings.answerInThread = slack.answerInThread
    settings.newSessionPerThread = slack.newSessionPerThread
  }
  const webhookStatus = slack?.webhookStatus ?? 'pending'

  return {
    ...publicFields,
    provider: provider as ChatProvider,
    // A Slack installation set up with webhooks has no bot token until its app exists.
    hasCredentials: parsed !== null && (!slack || !!slack.botToken),
    settings,
    ...(slack ? {
      slack: {
        botTokenSaved: !!slack.botToken,
        appTokenSaved: !!slack.appToken,
        signingSecretSaved: !!slack.signingSecret,
        webhook: slack.relay ? { url: slack.relay.url, status: webhookStatus } : null,
      },
      // The card follows Slack's first delivery as it arrives.
      ...(slack.relay && webhookStatus !== 'verified' ? { refreshIntervalMs: 5000 } : {}),
    } : {}),
  }
}
