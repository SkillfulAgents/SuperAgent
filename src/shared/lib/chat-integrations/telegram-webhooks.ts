/**
 * Telegram over the webhook relay. A bot has either a webhook or getUpdates,
 * never both, and Telegram holds what it can't deliver for 24 hours. With a
 * relay, the host sets the installation's relay endpoint as the bot's webhook
 * and receives every update through it; without one, grammY's long polling
 * deletes the webhook first, which moves held updates to getUpdates.
 *
 * Telegram doesn't sign its posts: it sends back the webhook's secret_token in
 * a header. The relay's verification profiles all sign the body, so the host
 * checks that header itself.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { Api } from 'grammy'
import type { Update } from 'grammy/types'
import { z } from 'zod'
import { db } from '../db'
import { changesOf } from '../db/batch'
import { chatIntegrations } from '../db/schema'
import { captureException } from '../error-reporting'
import { webhookEnvelopeSchema } from '../services/webhook-endpoint-schema'
import type { RelayEvent } from '../webhook-relay'
import { disableIntegrationRelay, integrationRelayName, provisionIntegrationRelay } from '../agent-integrations/relay-transport'
import { integrationRelayBindingSchema, type IntegrationRelayBinding } from '../agent-integrations/transport'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { telegramConfigSchema, type TelegramConfig } from './config-schema'

/** The updates the connector handles, on either path. */
export const TELEGRAM_UPDATE_TYPES = ['message', 'callback_query'] as const

const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

/** Aborts a Bot API call after `ms` (grammY types its signals with a polyfill's AbortSignal). */
export function telegramTimeout(ms: number): Parameters<Api['getMe']>[0] {
  return AbortSignal.timeout(ms) as Parameters<Api['getMe']>[0]
}

export interface TelegramWebhook {
  relay: IntegrationRelayBinding
  secret: string
}

/**
 * The secret_token a bot's webhook carries: the installation's secret, bound
 * to the bot's id (its token's prefix, which a revoked token keeps). If the
 * installation moves to another bot, the old bot's webhook still posts here,
 * with a token that no longer matches.
 */
export function telegramSecretToken(secret: string, botToken: string): string {
  return createHmac('sha256', secret).update(botToken.split(':')[0]).digest('hex')
}

const installation = (id: string) => and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, 'telegram'))

async function storedWebhook(integrationId: string): Promise<{ webhook: TelegramWebhook | null } | null> {
  const row = await db.select({ config: chatIntegrations.config }).from(chatIntegrations).where(installation(integrationId)).get()
  if (!row) return null
  let raw: unknown
  try {
    raw = JSON.parse(row.config)
  } catch {
    throw new Error('Telegram integration config is not valid JSON')
  }
  const { relay, webhookSecret } = telegramConfigSchema.parse(raw)
  return { webhook: relay && webhookSecret ? { relay, secret: webhookSecret } : null }
}

/** Stores the endpoint unless the installation has one by now. True when this one was stored. */
async function saveWebhook(integrationId: string, webhook: TelegramWebhook): Promise<boolean> {
  const relay = JSON.stringify(integrationRelayBindingSchema.parse(webhook.relay))
  const secret = telegramConfigSchema.shape.webhookSecret.parse(webhook.secret)
  // Only these two fields, so a concurrent settings edit is kept.
  const result = await db.update(chatIntegrations)
    .set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${relay}), '$.webhookSecret', ${secret})`, updatedAt: new Date() })
    .where(and(installation(integrationId), isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`))).run()
  return changesOf(result) > 0
}

/**
 * The installation's endpoint and secret token. The first connect with a
 * relay mints them; after that the address is fixed. Null if the
 * installation is gone.
 */
export async function ensureTelegramWebhook(integration: Pick<AgentIntegrationRecord, 'id' | 'agentSlug' | 'createdByUserId'>): Promise<TelegramWebhook | null> {
  const stored = await storedWebhook(integration.id)
  if (!stored || stored.webhook) return stored?.webhook ?? null

  const secret = randomBytes(32).toString('hex')
  const relay = await provisionIntegrationRelay(integrationRelayName('Telegram', integration.agentSlug), integration.createdByUserId ?? undefined)
  let saved = false
  try {
    saved = await saveWebhook(integration.id, { relay, secret })
    return saved ? { relay, secret } : (await storedWebhook(integration.id))?.webhook ?? null
  } finally {
    // Unused: the installation is gone, another connect stored its own, or the write failed.
    if (!saved) {
      await disableIntegrationRelay(relay).catch((error: unknown) => {
        captureException(error, { tags: { component: 'chat-integration', operation: 'telegram-release-relay-endpoint' }, extra: { integrationId: integration.id } })
      })
    }
  }
}

/**
 * The installation is being deleted: the bot stops posting to its endpoint,
 * which is disabled after this. Left alone if the bot's webhook is no longer
 * ours, e.g. the bot now runs somewhere else.
 */
export async function deleteTelegramWebhook(config: Pick<TelegramConfig, 'botToken' | 'relay'>): Promise<void> {
  if (!config.relay) return
  const api = new Api(config.botToken)
  const signal = telegramTimeout(15_000)
  const info = await api.getWebhookInfo(signal)
  if (info.url !== config.relay.url) return
  await api.deleteWebhook({ drop_pending_updates: false }, signal)
}

/** Only what the host reads before grammY takes the update over. */
const updateSchema = z.object({ update_id: z.number().int().nonnegative() }).loose()

export type TelegramWebhookCheck =
  | { ok: true; update: Update }
  | { ok: false; reason: 'malformed' | 'handshake' | 'secret' }

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
}

/** A relayed post's update, if it carries the bot's secret token. */
export function checkTelegramWebhook(event: RelayEvent, secretToken: string): TelegramWebhookCheck {
  const envelope = webhookEnvelopeSchema.safeParse(event.payload)
  if (!envelope.success || envelope.data.body === undefined) return { ok: false, reason: 'malformed' }
  if (envelope.data.kind === 'handshake') return { ok: false, reason: 'handshake' }
  const expected = Buffer.from(secretToken)
  const given = Buffer.from(header(envelope.data.headers, SECRET_HEADER) ?? '')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'secret' }

  const raw = Buffer.from(envelope.data.body, envelope.data.body_encoding === 'base64' ? 'base64' : 'utf8')
  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = updateSchema.safeParse(body)
  // grammY's filters read the rest, as they do for a polled update.
  return parsed.success ? { ok: true, update: parsed.data as Update } : { ok: false, reason: 'malformed' }
}
