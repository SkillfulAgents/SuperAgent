/**
 * Zod schemas for chat integration config validation.
 *
 * Used both at API boundary (route validation) and when parsing stored JSON from DB.
 */

import { z } from 'zod'

export const telegramConfigSchema = z.object({
  botToken: z.string().min(1, 'Bot token is required'),
  chatId: z.string().optional(),
})

export const slackConfigSchema = z.object({
  botToken: z.string().min(1, 'Bot token is required'),
  appToken: z.string().min(1, 'App-level token is required'),
  channelId: z.string().optional(),
  // Channel behavior toggles (only apply to channels, not DMs)
  onlyMentioned: z.boolean().optional(),
  answerInThread: z.boolean().optional(),
  newSessionPerThread: z.boolean().optional(),
})

export const imessageConfigSchema = z.object({
  gatewayUrl: z.string().url('Gateway URL is required').refine(
    (url) => url.startsWith('http://') || url.startsWith('https://'),
    'Gateway URL must start with http:// or https://',
  ),
  phoneNumber: z.string()
    .min(1, 'Phone number is required')
    .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be in E.164 format (e.g. +15551234567)'),
  token: z.string().min(1, 'Token is required'),
})

export type TelegramConfig = z.infer<typeof telegramConfigSchema>
export type SlackConfig = z.infer<typeof slackConfigSchema>
export type IMessageConfig = z.infer<typeof imessageConfigSchema>

export const CHAT_PROVIDERS = ['telegram', 'slack', 'imessage'] as const
export type ChatProvider = (typeof CHAT_PROVIDERS)[number]
type ChatConfig = TelegramConfig | SlackConfig | IMessageConfig

/**
 * Validate and parse a config object for the given provider.
 * Throws a descriptive error if validation fails.
 */
export function validateChatIntegrationConfig(
  provider: ChatProvider,
  config: unknown,
): ChatConfig {
  switch (provider) {
    case 'telegram': return telegramConfigSchema.parse(config)
    case 'slack': return slackConfigSchema.parse(config)
    case 'imessage': return imessageConfigSchema.parse(config)
    default: throw new Error(`Unknown chat integration provider: ${provider}`)
  }
}

/**
 * Safely parse a JSON config string from the database.
 * Returns null with a logged error if parsing or validation fails.
 */
export function parseChatIntegrationConfig(
  provider: ChatProvider,
  configJson: string,
): ChatConfig | null {
  try {
    const raw = JSON.parse(configJson)
    return validateChatIntegrationConfig(provider, raw)
  } catch (err) {
    console.error(`[ChatIntegration] Invalid config for ${provider}:`, err instanceof Error ? err.message : err)
    return null
  }
}
