/**
 * Slack over the webhook relay. A Slack app delivers its events and
 * interactions over Socket Mode or to request URLs, never both, and only the
 * person who owns the app can switch it. With webhooks set up, its Event
 * Subscriptions and Interactivity post to the installation's relay endpoint,
 * which answers Slack's URL check and its 3-second ack itself and holds what
 * arrives while the host is away.
 *
 * Slack signs every request with the app's signing secret (v0). The endpoint
 * checks that signature as posts arrive, and the host checks it again, at the
 * time the post was received, before handling one: a post can be claimed long
 * after it arrived, and the URL check skips the endpoint's verification.
 */

import { isValidSlackRequest } from '@slack/bolt'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { changesOf } from '../db/batch'
import { chatIntegrations } from '../db/schema'
import { webhookEnvelopeSchema } from '../services/webhook-endpoint-schema'
import { WebhookRelayUnavailableError, getWebhookRelay, type RelayEvent } from '../webhook-relay'
import { removeIntegrationWebhooks, setUpIntegrationWebhooks } from '../agent-integrations/relay-transport'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import { integrationRelayBindingSchema, type IntegrationRelayBinding } from '../agent-integrations/transport'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { isMaskedCredential, mergeChatIntegrationConfig, parseChatIntegrationConfig, slackConfigFieldsSchema, slackConfigSchema, type SlackConfig } from './config-schema'
import { chatDefinitions } from './definitions'
import { slackVerificationProfile } from './slack-verification'

export { slackVerificationProfile }

/** The endpoint checks posts against this signing secret from now on. */
export async function updateSlackWebhookSecret(relay: IntegrationRelayBinding, signingSecret: string): Promise<void> {
  try {
    await getWebhookRelay().updateEndpoint(relay.scope, relay.endpointId, { verification: slackVerificationProfile(signingSecret) })
  } catch (error) {
    if (error instanceof WebhookRelayUnavailableError) {
      throw new IntegrationSetupError('The webhook relay is unavailable, so the webhook URL can’t take the new signing secret yet. Try again when it’s back.')
    }
    throw error
  }
}

/**
 * Records what a post through the endpoint showed about the signing secret.
 * Only for the secret and endpoint the connection was given: a newer one
 * hasn't been seen to verify yet. True when it was recorded.
 */
export async function recordSlackWebhookStatus(
  integrationId: string,
  status: 'verified' | 'rejected',
  against: { signingSecret: string; endpointId: string },
): Promise<boolean> {
  const value = slackConfigSchema.shape.webhookStatus.unwrap().parse(status)
  const result = await db.update(chatIntegrations)
    .set({ config: sql`json_set(${chatIntegrations.config}, '$.webhookStatus', ${value})`, updatedAt: new Date() })
    .where(and(
      eq(chatIntegrations.id, integrationId),
      eq(chatIntegrations.provider, 'slack'),
      sql`json_extract(${chatIntegrations.config}, '$.signingSecret') = ${against.signingSecret}`,
      sql`json_extract(${chatIntegrations.config}, '$.relay.endpointId') = ${against.endpointId}`,
    )).run()
  return changesOf(result) > 0
}

/** Only what the host reads before Bolt takes the body over. */
const slackBodySchema = z.object({ type: z.string().min(1) }).loose()
export type SlackRequestBody = z.infer<typeof slackBodySchema>

/**
 * `verifiedBy`: `host` when the post matches the saved secret; `endpoint`
 * when it doesn't, but the endpoint checked it as it arrived (it was signed
 * with the secret before this one). `signed`: the post carried a signature at
 * all, as Slack's always do.
 */
export type SlackWebhookCheck =
  | { ok: true; kind: 'handshake'; verifiedBy: 'host' }
  | { ok: true; kind: 'request'; body: SlackRequestBody; verifiedBy: 'host' | 'endpoint' }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'signature'; signed: boolean }

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
}

/**
 * A relayed post's body, if Slack signed it: with this secret, or with the
 * one the endpoint checked it against as it arrived. Slack's URL check skips
 * the endpoint's verification, so only this secret verifies it.
 * Interactivity posts are form-encoded (`payload=<json>`); events are JSON.
 */
export function checkSlackWebhook(event: RelayEvent, signingSecret: string): SlackWebhookCheck {
  const envelope = webhookEnvelopeSchema.safeParse(event.payload)
  if (!envelope.success || envelope.data.body === undefined) return { ok: false, reason: 'malformed' }
  const { headers, received_at: receivedAt } = envelope.data
  const raw = Buffer.from(envelope.data.body, envelope.data.body_encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
  const signature = header(headers, 'x-slack-signature')
  const timestamp = Number(header(headers, 'x-slack-request-timestamp'))
  // Fresh as of when the endpoint received it, however long it then waited.
  const receivedMs = Date.parse(receivedAt ?? event.createdAt)
  const valid = !!signature && Number.isFinite(timestamp) && isValidSlackRequest({
    signingSecret,
    body: raw,
    headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp },
    nowMilliseconds: Number.isFinite(receivedMs) ? receivedMs : Date.now(),
  })
  const handshake = envelope.data.kind === 'handshake'
  if (!valid && (handshake || !envelope.data.verified)) return { ok: false, reason: 'signature', signed: !!signature }
  // Slack checking the URL, which the endpoint already answered.
  if (handshake) return { ok: true, kind: 'handshake', verifiedBy: 'host' }

  let body: unknown
  try {
    const form = /^application\/x-www-form-urlencoded/i.test(envelope.data.content_type ?? header(headers, 'content-type') ?? '')
    body = JSON.parse(form ? new URLSearchParams(raw).get('payload') ?? '' : raw)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const parsed = slackBodySchema.safeParse(body)
  return parsed.success ? { ok: true, kind: 'request', body: parsed.data, verifiedBy: valid ? 'host' : 'endpoint' } : { ok: false, reason: 'malformed' }
}

/**
 * What identifies one Slack request across redeliveries: Slack retries an
 * event with the same event_id, and an interaction with the same trigger_id.
 */
export function slackRequestKey(body: SlackRequestBody): string | null {
  const id = typeof body.event_id === 'string' ? body.event_id : typeof body.trigger_id === 'string' ? body.trigger_id : null
  return id ? `${body.type}:${id}` : null
}

const settingsInputSchema = z.object({
  settings: z.object({ webhooks: z.boolean().optional() }).loose().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).loose()

const installation = (id: string) => and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, 'slack'))

/**
 * Stores the endpoint with the secret it checks posts against, unless the
 * installation has one by now. Together, so a change that fails after this
 * can't leave webhooks without their secret.
 */
async function saveWebhook(integrationId: string, relay: IntegrationRelayBinding, signingSecret: string): Promise<void> {
  const binding = JSON.stringify(integrationRelayBindingSchema.parse(relay))
  const secret = slackConfigFieldsSchema.shape.signingSecret.unwrap().parse(signingSecret)
  // Only these fields, so a concurrent settings edit is kept.
  const result = await db.update(chatIntegrations)
    .set({ config: sql`json_remove(json_set(${chatIntegrations.config}, '$.relay', json(${binding}), '$.signingSecret', ${secret}), '$.webhookStatus')`, updatedAt: new Date() })
    .where(and(installation(integrationId), isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`))).run()
  if (changesOf(result) === 0) throw new IntegrationSetupError('Webhooks are already set up')
}

/** With an app-level token supplied in the same change, stored with it: without one, the config has no way to receive. */
async function forgetWebhook(integrationId: string, appToken?: string): Promise<void> {
  const forgotten = sql`json_remove(${chatIntegrations.config}, '$.relay', '$.webhookStatus')`
  const token = appToken === undefined ? undefined : slackConfigFieldsSchema.shape.appToken.unwrap().parse(appToken)
  await db.update(chatIntegrations)
    .set({ config: token === undefined ? forgotten : sql`json_set(${forgotten}, '$.appToken', ${token})`, updatedAt: new Date() })
    .where(installation(integrationId)).run()
}

/** A credential this change supplies: present, and not a masked placeholder. */
function supplied(patch: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = patch?.[key]
  return typeof value === 'string' && value.trim() && !isMaskedCredential(value) ? value.trim() : undefined
}

/** A bot token is checked before it's saved, so a mistyped one can't strand an installation that has none yet. */
async function checkBotToken(botToken: string): Promise<void> {
  let result: { ok?: boolean; error?: string }
  try {
    const response = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(15_000) })
    result = z.object({ ok: z.boolean(), error: z.string().optional() }).loose().parse(await response.json())
  } catch {
    throw new IntegrationSetupError('Couldn’t reach Slack to check the bot token. Try again.')
  }
  if (!result.ok) throw new IntegrationSetupError(`Bot token invalid: ${result.error ?? 'unknown error'}`)
}

/**
 * Settings that set webhooks up (`webhooks: true`, with a signing secret
 * saved or in the same change), remove them (`webhooks: false`, with an
 * app-level token for Socket Mode), or give the endpoint a signing secret.
 * The app itself is switched in Slack, by its owner.
 */
export async function updateSlackWebhookSettings(record: AgentIntegrationRecord, input: unknown): Promise<{ reconnect: boolean }> {
  const { settings, config: patch } = settingsInputSchema.parse(input)
  const webhooks = settings?.webhooks
  const secret = supplied(patch, 'signingSecret')
  const botToken = supplied(patch, 'botToken')
  // Anything else (other settings, pausing, repairing an unreadable row) isn't this function's.
  if (webhooks === undefined && !secret && !botToken) return { reconnect: false }
  const stored = parseChatIntegrationConfig('slack', record.config) as SlackConfig | null
  if (!stored) {
    if (webhooks !== undefined) throw new IntegrationSetupError('This Slack integration’s settings can’t be read. Fix its tokens first.')
    return { reconnect: false }
  }
  if (botToken && !stored.botToken) await checkBotToken(botToken)
  // What the installation holds once this change's config is saved.
  const next = patch ? mergeChatIntegrationConfig('slack', record.config, patch) as SlackConfig : stored

  if (webhooks === true && !stored.relay) {
    if (!next.signingSecret) throw new IntegrationSetupError('Paste the app’s signing secret first. It’s how this agent knows a request came from Slack.')
    const signingSecret = next.signingSecret
    await setUpIntegrationWebhooks(record, chatDefinitions.slack, relay => saveWebhook(record.id, relay, signingSecret), slackVerificationProfile(signingSecret))
    return { reconnect: true }
  }
  if (webhooks === false && stored.relay) {
    if (!next.botToken) throw new IntegrationSetupError('Finish setting up the Slack app first.')
    if (!next.appToken) throw new IntegrationSetupError('Paste the app-level token first. Without webhooks, Slack delivers over Socket Mode.')
    await removeIntegrationWebhooks(record, () => forgetWebhook(record.id, next.appToken !== stored.appToken ? next.appToken : undefined))
    return { reconnect: true }
  }
  // Saving the secret again also repairs an endpoint that never got it.
  if (secret && stored.relay) {
    await updateSlackWebhookSecret(stored.relay, secret)
    return { reconnect: true }
  }
  return { reconnect: false }
}
