/**
 * Zod schemas for chat integration config validation.
 *
 * Used both at API boundary (route validation) and when parsing stored JSON from DB.
 */

import { z } from 'zod'
import { integrationRelayConfigShape } from '../agent-integrations/transport'

export const telegramConfigSchema = z.object({
  botToken: z.string().min(1, 'Bot token is required'),
  chatId: z.string().optional(),
  // Rich Messages (Bot API 10.1). Defaults are applied in the connector.
  richMessages: z.boolean().optional(),        // global rollback switch (default: rich)
  draftStreaming: z.boolean().optional(),       // animated DM streaming (default: on)
  skipEntityDetection: z.boolean().optional(),  // default: false (auto-detection ON)
  /** The relay endpoint set as the bot's webhook; minted on the first connect with a relay. */
  ...integrationRelayConfigShape,
  /** The webhook's secret_token, which Telegram sends back on every post. Generated with the endpoint and never shown. */
  webhookSecret: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/).optional(),
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

export const IMESSAGE_GATEWAY_URL = 'https://imsgw.com'

/**
 * The single Gamut iMessage line every agent is reached on. Shared because setup
 * texts it and the contact card lists it as the agent's number: if they ever
 * disagree, the card ships a dead `TEL` while setup keeps working.
 */
export const IMESSAGE_PHONE_E164 = '+12053967934'

export const imessageConfigSchema = z.object({
  gatewayUrl: z.string().url('Gateway URL is required').refine(
    (url) => url.startsWith('http://') || url.startsWith('https://'),
    'Gateway URL must start with http:// or https://',
  ),
  phoneNumber: z.string()
    .min(1, 'Phone number is required')
    .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be in E.164 format (e.g. +15551234567)'),
  token: z.string().min(1, 'Token is required'),
  /** The relay endpoint the gateway delivers to while the socket is down; minted on the first connect with a relay. */
  ...integrationRelayConfigShape,
  /** Signs the gateway's webhook deliveries. Generated with the endpoint and never shown. */
  webhookSecret: z.string().min(16).max(256).optional(),
})

/** Config the host writes itself; a settings patch or setup input can't supply it. */
const HOST_OWNED_FIELDS: Partial<Record<string, readonly string[]>> = {
  telegram: ['relay', 'webhookSecret'],
  imessage: ['relay', 'webhookSecret'],
}

export const imessageSetupSchema = z.object({
  phoneNumber: z.string()
    .min(1, 'Phone number is required')
    .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be in E.164 format (e.g. +15551234567)'),
  code: z.string().min(1, 'Code is required').regex(/^\d{6}$/, 'Code must be 6 digits'),
})

export type TelegramConfig = z.infer<typeof telegramConfigSchema>
export type SlackConfig = z.infer<typeof slackConfigSchema>
export type IMessageConfig = z.infer<typeof imessageConfigSchema>

export const CHAT_PROVIDERS = ['telegram', 'slack', 'imessage'] as const
export type ChatProvider = (typeof CHAT_PROVIDERS)[number]
type ChatConfig = TelegramConfig | SlackConfig | IMessageConfig

const configPatchSchema = z.record(z.string(), z.unknown())

const MASKED_CREDENTIAL = /^(?:(?:\*|•){4,}(?:[A-Za-z0-9_-]{0,4})?|redacted|\[redacted\]|<redacted>)$/i

const CREDENTIAL_FIELDS: Record<ChatProvider, readonly string[]> = {
  telegram: ['botToken'],
  slack: ['botToken', 'appToken'],
  imessage: ['gatewayUrl', 'token'],
}

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

/** Drops the fields only the host may write from caller-supplied config. */
export function withoutHostOwnedConfig(provider: ChatProvider, config: Record<string, unknown>): Record<string, unknown> {
  const owned = HOST_OWNED_FIELDS[provider] ?? []
  return Object.fromEntries(Object.entries(config).filter(([key]) => !owned.includes(key)))
}

/**
 * Merge an API config patch with the credential-bearing stored config.
 * Omitted credentials and conventional masked placeholders preserve the
 * existing value so settings can be edited without ever reading secrets back.
 */
export function mergeChatIntegrationConfig(
  provider: ChatProvider,
  storedConfigJson: string,
  patch: unknown,
): ChatConfig {
  const parsedPatch = withoutHostOwnedConfig(provider, configPatchSchema.parse(patch))
  const credentialFields = CREDENTIAL_FIELDS[provider]
  const unmaskedPatch = Object.fromEntries(
    Object.entries(parsedPatch).filter(([key, value]) =>
      !credentialFields.includes(key)
      || typeof value !== 'string'
      || !MASKED_CREDENTIAL.test(value),
    ),
  )

  const stored = parseChatIntegrationConfig(provider, storedConfigJson)
  // A corrupt or legacy row must remain repairable. When the old value cannot
  // be trusted, require the patch itself to be a complete valid replacement.
  if (!stored) return validateChatIntegrationConfig(provider, unmaskedPatch)

  return validateChatIntegrationConfig(provider, { ...stored, ...unmaskedPatch })
}
