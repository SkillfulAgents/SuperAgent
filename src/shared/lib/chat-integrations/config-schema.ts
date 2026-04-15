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
})

export type TelegramConfig = z.infer<typeof telegramConfigSchema>
export type SlackConfig = z.infer<typeof slackConfigSchema>

/**
 * Validate and parse a config object for the given provider.
 * Throws a descriptive error if validation fails.
 */
export function validateChatIntegrationConfig(
  provider: 'telegram' | 'slack',
  config: unknown,
): TelegramConfig | SlackConfig {
  const schema = provider === 'telegram' ? telegramConfigSchema : slackConfigSchema
  return schema.parse(config)
}

/**
 * Safely parse a JSON config string from the database.
 * Returns null with a logged error if parsing or validation fails.
 */
export function parseChatIntegrationConfig(
  provider: 'telegram' | 'slack',
  configJson: string,
): TelegramConfig | SlackConfig | null {
  try {
    const raw = JSON.parse(configJson)
    return validateChatIntegrationConfig(provider, raw)
  } catch (err) {
    console.error(`[ChatIntegration] Invalid config for ${provider}:`, err instanceof Error ? err.message : err)
    return null
  }
}
