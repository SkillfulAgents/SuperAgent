import type { ChatIntegration } from '@shared/lib/db/schema'
import {
  parseChatIntegrationConfig,
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

export type PublicChatIntegration = Omit<ChatIntegration, 'config'> & {
  hasCredentials: boolean
  settings: PublicChatIntegrationSettings
}

/**
 * Convert the internal credential-bearing DB row into its API-safe form.
 * Keep this as the only serialization boundary for chat integrations: callers
 * inside the process still receive the full row needed by connectors.
 */
export function toPublicChatIntegration(integration: ChatIntegration): PublicChatIntegration {
  const { config, ...publicFields } = integration
  const parsed = typeof config === 'string'
    ? parseChatIntegrationConfig(integration.provider, config)
    : null

  const settings: PublicChatIntegrationSettings = {}
  if (parsed && integration.provider === 'telegram') {
    const telegram = parsed as TelegramConfig
    settings.richMessages = telegram.richMessages
    settings.draftStreaming = telegram.draftStreaming
    settings.skipEntityDetection = telegram.skipEntityDetection
  } else if (parsed && integration.provider === 'slack') {
    const slack = parsed as SlackConfig
    settings.onlyMentioned = slack.onlyMentioned
    settings.answerInThread = slack.answerInThread
    settings.newSessionPerThread = slack.newSessionPerThread
  }

  return {
    ...publicFields,
    hasCredentials: parsed !== null,
    settings,
  }
}
