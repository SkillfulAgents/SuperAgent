/**
 * Email over the webhook relay. The gateway posts a pointer to each new event
 * of a mailbox that no stream covers to that mailbox's webhook. With a relay,
 * the host opens no stream: it registers a relay endpoint as the webhook, and
 * each pointer wakes the mailbox's cursor poll, which stays the source of truth.
 *
 * One endpoint serves every mailbox claimed under the same relay scope (the
 * creator's platform member), to stay inside the platform's per-org endpoint
 * quota. Each installation stores a copy of it; the generic release disables
 * it only once no installation uses it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { changesOf } from '../db/batch'
import { chatIntegrations } from '../db/schema'
import { captureException } from '../error-reporting'
import { webhookEnvelopeSchema, type VerificationProfile } from '../services/webhook-endpoint-schema'
import { getWebhookRelay, type RelayAcceptResult, type RelayConsumerHandle, type RelayEvent, type WebhookRelayService } from '../webhook-relay'
import { disableIntegrationRelay, integrationRelayScope, provisionIntegrationRelay } from '../agent-integrations/relay-transport'
import { integrationRelayBindingSchema, integrationRelayConfigShape, type IntegrationRelayAttachment, type IntegrationRelayBinding } from '../agent-integrations/transport'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { EMAIL_PROVIDER, emailWebhookSecretSchema } from './config-schema'

export interface EmailWebhook {
  relay: IntegrationRelayBinding
  secret: string
}

/** The gateway signs with Standard Webhooks; the relay rejects posts that don't match, or are over 5 minutes old. */
export function emailVerificationProfile(secret: string): VerificationProfile {
  return {
    algorithm: 'hmac-sha256', encoding: 'base64', header: 'webhook-signature', template: '{webhook_id}.{timestamp}.{body}',
    timestamp_header: 'webhook-timestamp', webhook_id_header: 'webhook-id', secret, secret_encoding: 'base64',
  }
}

const storedWebhookSchema = z.object({ ...integrationRelayConfigShape, webhookSecret: emailWebhookSecretSchema.optional() })

async function readWebhook(where: ReturnType<typeof and>): Promise<{ webhook: EmailWebhook | null } | null> {
  const row = await db.select({ config: chatIntegrations.config }).from(chatIntegrations).where(where).get()
  if (!row) return null
  let raw: unknown
  try { raw = JSON.parse(row.config) } catch { throw new Error('Invalid stored email configuration') }
  const { relay, webhookSecret } = storedWebhookSchema.parse(raw)
  return { webhook: relay && webhookSecret ? { relay, secret: webhookSecret } : null }
}

const installation = (id: string) => and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, EMAIL_PROVIDER))

/** Stores the endpoint unless the installation has one by now. True when this one was stored. */
async function saveWebhook(integrationId: string, webhook: EmailWebhook): Promise<boolean> {
  const relay = JSON.stringify(integrationRelayBindingSchema.parse(webhook.relay))
  const secret = emailWebhookSecretSchema.parse(webhook.secret)
  // Only these two fields, so a concurrent cursor checkpoint or settings edit is kept.
  const result = await db.update(chatIntegrations)
    .set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${relay}), '$.webhookSecret', ${secret})`, updatedAt: new Date() })
    .where(and(installation(integrationId), isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`))).run()
  return changesOf(result) > 0
}

/** One mint at a time per scope, so mailboxes connecting together share the first one's endpoint. */
const minting = new Map<string, Promise<unknown>>()
function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (minting.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
  minting.set(key, next)
  void next.catch(() => {}).finally(() => { if (minting.get(key) === next) minting.delete(key) })
  return next
}

/**
 * The installation's endpoint and signing secret. The first connect with a
 * relay takes those of another mailbox in the same scope, or mints them; after
 * that the address is fixed. Null if the installation is gone.
 */
export async function ensureEmailWebhook(integration: Pick<AgentIntegrationRecord, 'id' | 'createdByUserId'>): Promise<EmailWebhook | null> {
  const own = await readWebhook(installation(integration.id))
  if (!own || own.webhook) return own?.webhook ?? null
  const scope = await integrationRelayScope(integration.createdByUserId ?? undefined)
  return oneAtATime(scope, async () => {
    const current = await readWebhook(installation(integration.id))
    if (!current || current.webhook) return current?.webhook ?? null
    const shared = await readWebhook(and(
      eq(chatIntegrations.provider, EMAIL_PROVIDER), ne(chatIntegrations.id, integration.id),
      sql`json_extract(${chatIntegrations.config}, '$.relay.scope') = ${scope}`,
      sql`json_extract(${chatIntegrations.config}, '$.webhookSecret') IS NOT NULL`,
    ))
    if (shared?.webhook) {
      if (await saveWebhook(integration.id, shared.webhook)) return shared.webhook
      return (await readWebhook(installation(integration.id)))?.webhook ?? null
    }

    const secret = `whsec_${randomBytes(32).toString('base64')}`
    const relay = await provisionIntegrationRelay('Email inboxes', integration.createdByUserId ?? undefined, emailVerificationProfile(secret))
    let stored = false
    try {
      stored = await saveWebhook(integration.id, { relay, secret })
      return stored ? { relay, secret } : (await readWebhook(installation(integration.id)))?.webhook ?? null
    } finally {
      // Unused: the installation is gone, it got an endpoint meanwhile, or the write failed.
      if (!stored) {
        await disableIntegrationRelay(relay).catch((error: unknown) => {
          captureException(error, { tags: { component: 'email-integration', operation: 'release-relay-endpoint' }, extra: { integrationId: integration.id } })
        })
      }
    }
  })
}

/** The gateway's post: a pointer to one event. The cursor poll reads the event itself. */
const emailWebhookPointerSchema = z.object({
  type: z.string(),
  id: z.string(),
  cursor: z.number().int().nonnegative(),
  mailboxId: z.string(),
  messageId: z.string().nullable(),
  createdAt: z.number(),
}).loose()
export type EmailWebhookPointer = z.infer<typeof emailWebhookPointerSchema>

/** Pointers this host can't act on; the relay drops them. */
export type EmailWebhookRejection = 'malformed' | 'handshake' | 'signature'

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
}

/** The pointer in a relayed post, unverified: its mailbox says which secret to check it with. */
export function readEmailWebhook(event: RelayEvent): { ok: true; pointer: EmailWebhookPointer; raw: Buffer; headers?: Record<string, string> } | { ok: false; reason: EmailWebhookRejection } {
  const envelope = webhookEnvelopeSchema.safeParse(event.payload)
  if (!envelope.success || envelope.data.body === undefined) return { ok: false, reason: 'malformed' }
  if (envelope.data.kind === 'handshake') return { ok: false, reason: 'handshake' }
  const raw = Buffer.from(envelope.data.body, envelope.data.body_encoding === 'base64' ? 'base64' : 'utf8')
  let body: unknown
  try { body = JSON.parse(raw.toString('utf8')) } catch { return { ok: false, reason: 'malformed' } }
  const pointer = emailWebhookPointerSchema.safeParse(body)
  return pointer.success ? { ok: true, pointer: pointer.data, raw, headers: envelope.data.headers } : { ok: false, reason: 'malformed' }
}

/**
 * Checks a post's Standard Webhooks signature with the saved secret, but not
 * its age: the relay applied the 5-minute window when it received the post,
 * and a relayed event can be claimed long after that.
 */
export function emailWebhookSigned(raw: Buffer, headers: Record<string, string> | undefined, secret: string): boolean {
  const id = header(headers, 'webhook-id')
  const timestamp = header(headers, 'webhook-timestamp')
  const signatures = header(headers, 'webhook-signature')
  if (!id || !timestamp || !signatures) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest()
  // Space-separated `v1,<base64>` entries; any one matching is enough.
  return signatures.split(' ').some(entry => {
    const [version, value] = entry.split(',', 2)
    if (version !== 'v1' || !value) return false
    const given = Buffer.from(value, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

/** Polls the mailbox until its cursor reaches `cursor`, as far as it can; resolves to where it got. */
export type EmailCatchUp = (cursor: number) => Promise<number>

interface Mailbox { secret: string; catchUp: EmailCatchUp }
interface Group { handle: RelayConsumerHandle; mailboxes: Map<string, Mailbox> }

/**
 * One relay registration per endpoint, shared by the mailboxes attached to it.
 * Like `integrationRelays`, it outlives the connections: nothing is claimed
 * while no mailbox is attached.
 */
export class EmailRelays {
  private readonly groups = new Map<string, Group>()

  constructor(private readonly relay: () => WebhookRelayService = getWebhookRelay) {}

  attach(webhook: EmailWebhook, mailboxId: string, catchUp: EmailCatchUp): IntegrationRelayAttachment {
    const { relay: binding } = webhook
    let group = this.groups.get(binding.endpointId)
    const mailbox: Mailbox = { secret: webhook.secret, catchUp }
    if (group) {
      group.mailboxes.set(mailboxId, mailbox)
      group.handle.update({ scope: binding.scope, endpointIds: [binding.endpointId] })
      group.handle.retryNow()
    } else {
      const created: Group = { handle: null as unknown as RelayConsumerHandle, mailboxes: new Map([[mailboxId, mailbox]]) }
      created.handle = this.relay().register({
        id: `email-integrations:${binding.endpointId}`,
        scope: binding.scope,
        endpointIds: [binding.endpointId],
        accept: events => this.accept(created, events),
      })
      this.groups.set(binding.endpointId, created)
      group = created
    }
    const attached = group
    const current = () => this.groups.get(binding.endpointId) === attached && attached.mailboxes.get(mailboxId) === mailbox
    return {
      detach: () => {
        if (!current()) return
        attached.mailboxes.delete(mailboxId)
        if (!attached.mailboxes.size) attached.handle.update({ endpointIds: [] })
      },
      isAttached: current,
    }
  }

  /**
   * Each mailbox catches up once, to its newest pointer. A pointer is taken once
   * the cursor is past it, and retried otherwise. One for a mailbox that isn't
   * attached is dropped: its next connect polls from its cursor anyway.
   */
  private async accept(group: Group, events: readonly RelayEvent[]): Promise<Map<string, RelayAcceptResult>> {
    const results = new Map<string, RelayAcceptResult>()
    const due = new Map<Mailbox, Array<{ id: string; cursor: number }>>()
    for (const event of events) {
      const post = readEmailWebhook(event)
      const mailbox = post.ok ? group.mailboxes.get(post.pointer.mailboxId) : undefined
      if (!post.ok || !mailbox || !emailWebhookSigned(post.raw, post.headers, mailbox.secret)) {
        const reason = !post.ok ? post.reason : mailbox ? 'signature' : 'detached'
        if (reason !== 'handshake' && reason !== 'detached') console.warn(`[EmailRelays] Discarding relayed post ${event.id}: ${reason}`)
        results.set(event.id, 'discard')
        continue
      }
      due.set(mailbox, [...due.get(mailbox) ?? [], { id: event.id, cursor: post.pointer.cursor }])
    }
    await Promise.all([...due].map(async ([mailbox, pointers]) => {
      let reached = -1
      try { reached = await mailbox.catchUp(Math.max(...pointers.map(pointer => pointer.cursor))) }
      catch (error) { captureException(error, { tags: { component: 'email-integration', operation: 'relay-catch-up' } }) }
      for (const pointer of pointers) results.set(pointer.id, reached >= pointer.cursor ? 'accepted' : 'retry')
    }))
    return results
  }
}

// Persists across hot reloads like the relay itself: a fresh copy would hold
// no registrations and collide with the relay's on the next attach.
const globalForEmailRelays = globalThis as unknown as { emailRelays: EmailRelays | undefined }
globalForEmailRelays.emailRelays ??= new EmailRelays()
export const emailRelays = globalForEmailRelays.emailRelays
