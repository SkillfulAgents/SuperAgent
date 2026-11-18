/**
 * iMessage over the webhook relay. The gateway sends each event to a live
 * socket, else to the phone's registered webhook, else holds it (24h) for
 * the next socket. With a relay, the host opens no socket: it registers its
 * relay endpoint as that webhook, receives everything through it, and sends
 * over the gateway's HTTP API (imessage-gateway-client.ts).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { chatIntegrations } from '@shared/lib/db/schema'
import { captureException } from '@shared/lib/error-reporting'
import { webhookEnvelopeSchema, type VerificationProfile } from '../services/webhook-endpoint-schema'
import type { RelayEvent } from '../webhook-relay'
import { disableIntegrationRelay, integrationRelayName, provisionIntegrationRelay } from '../agent-integrations/relay-transport'
import type { IntegrationRelayBinding } from '../agent-integrations/transport'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { imessageConfigSchema, type IMessageConfig } from './config-schema'

/**
 * Every event the gateway keeps until delivered, including ones the connector
 * ignores: a type the webhook doesn't take is held for a socket that never
 * comes, and held events count toward the gateway's 1,000-event cap, which
 * would push out messages still waiting for the relay.
 */
export const IMESSAGE_WEBHOOK_EVENTS = ['message.received', 'message.sent', 'message.failed', 'message.edited', 'reaction.added', 'reaction.removed'] as const

const SIGNATURE_HEADER = 'x-imsgw-signature'
const TIMESTAMP_HEADER = 'x-imsgw-timestamp'
const EVENT_ID_HEADER = 'x-imsgw-event-id'

/** How the gateway signs deliveries; the relay rejects any that don't match, or are over 5 minutes old. */
export function imessageVerificationProfile(secret: string): VerificationProfile {
  return {
    algorithm: 'hmac-sha256', encoding: 'hex', header: SIGNATURE_HEADER, template: '{timestamp}.{body}',
    timestamp_header: TIMESTAMP_HEADER, webhook_id_header: EVENT_ID_HEADER, secret,
  }
}

export interface IMessageWebhook {
  relay: IntegrationRelayBinding
  secret: string
}

function parseStoredConfig(json: string): IMessageConfig {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('iMessage integration config is not valid JSON')
  }
  return imessageConfigSchema.parse(raw)
}

/** The installation's stored config, and the endpoint and secret in it. */
async function storedWebhook(integrationId: string): Promise<{ json: string; config: IMessageConfig; webhook: IMessageWebhook | null } | null> {
  const row = await db.select({ config: chatIntegrations.config }).from(chatIntegrations)
    .where(and(eq(chatIntegrations.id, integrationId), eq(chatIntegrations.provider, 'imessage'))).get()
  if (!row) return null
  const config = parseStoredConfig(row.config)
  return { json: row.config, config, webhook: config.relay && config.webhookSecret ? { relay: config.relay, secret: config.webhookSecret } : null }
}

/**
 * The installation's endpoint and signing secret. The first connect with a
 * relay mints them; after that the address is fixed. Null if the
 * installation is gone.
 */
export async function ensureIMessageWebhook(integration: Pick<AgentIntegrationRecord, 'id' | 'agentSlug' | 'createdByUserId'>): Promise<IMessageWebhook | null> {
  const stored = await storedWebhook(integration.id)
  if (!stored || stored.webhook) return stored?.webhook ?? null

  const secret = randomBytes(32).toString('hex')
  const relay = await provisionIntegrationRelay(integrationRelayName('iMessage', integration.agentSlug), integration.createdByUserId ?? undefined, imessageVerificationProfile(secret))
  let saved: IMessageWebhook | null = null
  try {
    saved = await saveWebhook(integration.id, { relay, secret })
    return saved
  } finally {
    // Unused: the installation is gone, another connect stored its own, or the write failed.
    if (saved?.relay.endpointId !== relay.endpointId) {
      await disableIntegrationRelay(relay).catch((error: unknown) => {
        captureException(error, { tags: { component: 'chat-integration', operation: 'imessage-release-relay-endpoint' }, extra: { integrationId: integration.id } })
      })
    }
  }
}

/** Stores a minted endpoint unless the installation has one by now; returns the one it ends up with. */
async function saveWebhook(integrationId: string, minted: IMessageWebhook): Promise<IMessageWebhook | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await storedWebhook(integrationId)
    if (!latest || latest.webhook) return latest?.webhook ?? null
    const next = imessageConfigSchema.parse({ ...latest.config, relay: minted.relay, webhookSecret: minted.secret })
    const result = await db.update(chatIntegrations).set({ config: JSON.stringify(next), updatedAt: new Date() })
      .where(and(eq(chatIntegrations.id, integrationId), eq(chatIntegrations.config, latest.json))).run()
    if (changesOf(result) > 0) return minted
  }
  throw new Error('iMessage integration config changed concurrently')
}

/** A gateway webhook delivery: the socket event plus the phone it belongs to. */
const gatewayDeliverySchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  seq: z.number().optional(),
  createdAt: z.string().optional(),
  phoneNumber: z.string(),
  data: z.unknown().optional(),
}).loose()
export type GatewayDelivery = z.infer<typeof gatewayDeliverySchema>

export type IMessageWebhookCheck =
  | { ok: true; delivery: GatewayDelivery }
  | { ok: false; reason: 'malformed' | 'handshake' | 'signature' | 'other_phone' }

/**
 * Verifies a relayed delivery's signature with the saved secret, but not its
 * age: the relay applied the 5-minute window when it received the delivery,
 * and a relayed event can be claimed long after that.
 */
export function checkIMessageWebhook(event: RelayEvent, secret: string, phoneNumber: string): IMessageWebhookCheck {
  const envelope = webhookEnvelopeSchema.safeParse(event.payload)
  if (!envelope.success || envelope.data.body === undefined) return { ok: false, reason: 'malformed' }
  if (envelope.data.kind === 'handshake') return { ok: false, reason: 'handshake' }
  const raw = Buffer.from(envelope.data.body, envelope.data.body_encoding === 'base64' ? 'base64' : 'utf8')
  const signature = envelope.data.headers?.[SIGNATURE_HEADER]
  const timestamp = envelope.data.headers?.[TIMESTAMP_HEADER]
  if (!signature || !timestamp) return { ok: false, reason: 'signature' }
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex'))
  const given = Buffer.from(signature.toLowerCase())
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature' }

  let body: unknown
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = gatewayDeliverySchema.safeParse(body)
  if (!parsed.success) return { ok: false, reason: 'malformed' }
  const delivery = parsed.data
  // The endpoint outlives a phone number change; the old number's events aren't ours.
  if (delivery.phoneNumber !== phoneNumber) return { ok: false, reason: 'other_phone' }
  return { ok: true, delivery }
}
