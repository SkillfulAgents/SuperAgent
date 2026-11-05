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
 *
 * Minting it takes a lease per scope, so one process mints while the others
 * wait, but the database decides. The platform's create has no idempotency key,
 * and a process can die, or lose the answer, after an endpoint was created. So an
 * intent goes into the installation's config first (see `recordIntent`), and the
 * minted endpoint's name carries its attempt id. The next connect finds the
 * intent, whichever mailbox it is for, looks for that name and adopts the
 * endpoint, or mints again with the same name and secret. Attaching is one
 * conditional statement (`attachIntent`), so a superseded attempt is refused, and
 * an endpoint nothing ended up using is disabled.
 *
 * A mint lost in flight can still land after the next attempt looked for it. If
 * that attempt has attached by then, the late endpoint has no intent left to
 * lead to it: a live URL nothing uses, recognisable only by its name.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, ne, notExists, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { defineLease, digestKeyPart, LeaseLostError, LeaseWaitTimeoutError, type LeaseHolding } from '../app-state'
import { db } from '../db'
import { changesOf } from '../db/batch'
import { chatIntegrations } from '../db/schema'
import { captureException } from '../error-reporting'
import { webhookEnvelopeSchema, type VerificationProfile } from '../services/webhook-endpoint-schema'
import { getWebhookRelay, type RelayAcceptResult, type RelayConsumerHandle, type RelayEvent, type WebhookRelayService } from '../webhook-relay'
import {
  RELAY_INTENT_REQUEST_TIMEOUT_MS,
  clearIntegrationRelayIntent,
  disableIntentRelayEndpoints,
  disableUnusedRelayEndpoints,
  findIntentRelayEndpoints,
  integrationRelayScope,
  mintIntentRelayEndpoint,
  relayBindingOf,
} from '../agent-integrations/relay-transport'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import { integrationRelayBindingSchema, integrationRelayConfigShape, type IntegrationRelayAttachment, type IntegrationRelayBinding } from '../agent-integrations/transport'
import type { AgentIntegrationRecord } from '../agent-integrations/types'
import { EMAIL_PROVIDER, emailRelayIntentSchema, emailWebhookSecretSchema, type EmailRelayIntent } from './config-schema'

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

/**
 * Derived from the request deadline, which is the longest a mint can run: `confirm`
 * asks for that much before the mint, and the rest is for the renewal's own round trip.
 */
const MINT_LEASE_TTL_MS = RELAY_INTENT_REQUEST_TIMEOUT_MS + 10_000
const mintLease = defineLease({ name: 'lease:email:webhook-mint', ttlMs: MINT_LEASE_TTL_MS })
/** Long enough for a dead holder's lease to lapse (one TTL) and a live one's list and mint. */
const MINT_LEASE_WAIT_MS = 2 * MINT_LEASE_TTL_MS
/** Normal work takes two: one to attach, one to read the answer. The rest are for refusals and scope changes. */
const MAX_PROVISION_PASSES = 4

const storedWebhookSchema = z.object({
  ...integrationRelayConfigShape,
  webhookSecret: emailWebhookSecretSchema.optional(),
  relayProvisioning: emailRelayIntentSchema.optional(),
})

interface StoredInstallation {
  id: string
  /** It has an endpoint, and that address is now fixed. */
  attached: boolean
  webhook: EmailWebhook | null
  /** The endpoint being provisioned or, once attached, an attempt's endpoints still to take down. */
  intent?: EmailRelayIntent
}

async function readInstallation(where: ReturnType<typeof and>): Promise<StoredInstallation | null> {
  const row = await db.select({ id: chatIntegrations.id, config: chatIntegrations.config }).from(chatIntegrations).where(where).get()
  if (!row) return null
  let raw: unknown
  try { raw = JSON.parse(row.config) } catch { throw new Error('Invalid stored email configuration') }
  const { relay, webhookSecret, relayProvisioning } = storedWebhookSchema.parse(raw)
  return { id: row.id, attached: !!relay, webhook: relay && webhookSecret ? { relay, secret: webhookSecret } : null, intent: relayProvisioning }
}

const installation = (id: string) => and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, EMAIL_PROVIDER))
const otherInstallation = (id: string) => and(ne(chatIntegrations.id, id), eq(chatIntegrations.provider, EMAIL_PROVIDER))
const hasEndpointIn = (scope: string) => and(
  sql`json_extract(${chatIntegrations.config}, '$.relay.scope') = ${scope}`,
  sql`json_extract(${chatIntegrations.config}, '$.webhookSecret') IS NOT NULL`,
)
const hasIntentIn = (scope: string) => and(
  isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`),
  sql`json_extract(${chatIntegrations.config}, '$.relayProvisioning.scope') = ${scope}`,
)

/**
 * Runs a write that carries the secret. Drizzle quotes a failed statement's
 * parameters in its own message, so only the driver's cause goes further.
 */
async function secretWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : error instanceof Error ? error.name : 'unknown error'
    throw new Error(`Could not save the email webhook: ${cause}`)
  }
}

/** Stores another mailbox's endpoint unless the installation has one by now. An intent of its own stays, to be settled. */
async function saveWebhook(integrationId: string, webhook: EmailWebhook): Promise<void> {
  const relay = JSON.stringify(integrationRelayBindingSchema.parse(webhook.relay))
  const secret = emailWebhookSecretSchema.parse(webhook.secret)
  // Only these two fields, so a concurrent cursor checkpoint or settings edit is kept.
  await secretWrite(async () => db.update(chatIntegrations)
    .set({ config: sql`json_set(${chatIntegrations.config}, '$.relay', json(${relay}), '$.webhookSecret', ${secret})`, updatedAt: new Date() })
    .where(and(installation(integrationId), isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`))).run())
}

/**
 * Stores the intent before anything is minted, unless the installation has an
 * endpoint or an intent by now, or its scope has an endpoint or another
 * installation's intent. One statement, so two attempts can't start in a scope
 * even if the lease lapsed. Null when refused.
 */
async function recordIntent(integrationId: string, scope: string): Promise<EmailRelayIntent | null> {
  const attemptId = randomBytes(8).toString('hex')
  const intent = emailRelayIntentSchema.parse({
    attemptId, scope, endpointName: `Email inboxes (${attemptId})`, secret: `whsec_${randomBytes(32).toString('base64')}`,
  })
  const result = await secretWrite(async () => db.update(chatIntegrations)
    .set({ config: sql`json_set(${chatIntegrations.config}, '$.relayProvisioning', json(${JSON.stringify(intent)}))`, updatedAt: new Date() })
    .where(and(
      installation(integrationId),
      isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`),
      isNull(sql`json_extract(${chatIntegrations.config}, '$.relayProvisioning')`),
      notExists(db.select({ one: sql`1` }).from(chatIntegrations).where(and(otherInstallation(integrationId), or(hasEndpointIn(scope), hasIntentIn(scope))))),
    )).run())
  return changesOf(result) > 0 ? intent : null
}

/**
 * Stores this attempt's endpoint and clears its intent, in one statement that
 * touches only those fields, if the installation has no endpoint and still has
 * this attempt's intent. False means the attempt was superseded.
 */
async function attachIntent(integrationId: string, attemptId: string, webhook: EmailWebhook): Promise<boolean> {
  const relay = JSON.stringify(integrationRelayBindingSchema.parse(webhook.relay))
  const secret = emailWebhookSecretSchema.parse(webhook.secret)
  const result = await secretWrite(async () => db.update(chatIntegrations)
    .set({ config: sql`json_remove(json_set(${chatIntegrations.config}, '$.relay', json(${relay}), '$.webhookSecret', ${secret}), '$.relayProvisioning')`, updatedAt: new Date() })
    .where(and(
      installation(integrationId),
      isNull(sql`json_extract(${chatIntegrations.config}, '$.relay')`),
      sql`json_extract(${chatIntegrations.config}, '$.relayProvisioning.attemptId') = ${attemptId}`,
    )).run())
  return changesOf(result) > 0
}

/** Puts an intent back on an installation that has none now, as the trail to what is still to take down. */
async function restoreIntent(integrationId: string, intent: EmailRelayIntent): Promise<void> {
  await secretWrite(async () => db.update(chatIntegrations)
    .set({ config: sql`json_set(${chatIntegrations.config}, '$.relayProvisioning', json(${JSON.stringify(intent)}))`, updatedAt: new Date() })
    .where(and(installation(integrationId), isNull(sql`json_extract(${chatIntegrations.config}, '$.relayProvisioning')`))).run())
}

function report(error: unknown, operation: string, extra: Record<string, unknown>): void {
  captureException(error, { tags: { component: 'email-integration', operation }, extra })
}

/**
 * Takes down endpoints of an attempt that nothing ended up using. A later
 * connect finds them through the intent, so a failed disable leaves it in place,
 * and puts it back if the attempt that won cleared it. Only an installation
 * holding another attempt's intent, or gone by now, leaves just the report.
 */
async function retireEndpoints(integrationId: string, intent: EmailRelayIntent, endpointIds: readonly string[]): Promise<void> {
  try {
    await disableUnusedRelayEndpoints(intent.scope, endpointIds)
  } catch (error) {
    report(error, 'release-relay-endpoint', { integrationId, endpointIds })
    await restoreIntent(integrationId, intent).catch((restoreError: unknown) => report(restoreError, 'keep-relay-intent', { integrationId }))
  }
}

/** An attached installation with an intent left: its attempt's endpoints are taken down, then the intent goes. */
async function settleAttached(own: StoredInstallation): Promise<EmailWebhook | null> {
  if (own.intent) {
    try {
      await disableIntentRelayEndpoints(own.intent)
      await clearIntegrationRelayIntent(own.id, own.intent.attemptId)
    } catch (error) {
      report(error, 'settle-relay-intent', { integrationId: own.id })
    }
  }
  return own.webhook
}

/**
 * The installation's platform identity moved to another scope. Its endpoint will
 * be minted in the new one, and the old scope may not answer any more, so this
 * tries once and lets go: the intent is cleared first, which also refuses an
 * attempt still running, and a failure is only reported.
 */
async function abandonIntent(integrationId: string, intent: EmailRelayIntent): Promise<void> {
  if (!(await clearIntegrationRelayIntent(integrationId, intent.attemptId))) return
  try {
    await disableIntentRelayEndpoints(intent)
  } catch (error) {
    report(error, 'abandon-relay-intent', { integrationId })
  }
}

/**
 * What the database already answers: the installation's endpoint or that of
 * another mailbox in the scope, null if the installation is gone, undefined if
 * one has to be provisioned. A waiter can use it without the lease: it mints
 * nothing, and its writes are conditional.
 */
async function existingWebhook(integrationId: string, scope: string): Promise<EmailWebhook | null | undefined> {
  const own = await readInstallation(installation(integrationId))
  if (!own) return null
  if (own.attached) return settleAttached(own)
  const shared = await readInstallation(and(otherInstallation(integrationId), hasEndpointIn(scope)))
  if (!shared?.webhook) return undefined
  await saveWebhook(integrationId, shared.webhook)
  const current = await readInstallation(installation(integrationId))
  return current?.attached ? settleAttached(current) : null
}

/** The endpoint for an attempt: one a lost mint left behind if it's recovering, or a new one. */
async function endpointFor(intent: EmailRelayIntent, recovering: boolean, holding: LeaseHolding): Promise<{ relay: IntegrationRelayBinding; spares: string[] }> {
  if (recovering) {
    const [found, ...spares] = await findIntentRelayEndpoints(intent)
    if (found) return { relay: relayBindingOf(found, intent.scope), spares: spares.map(spare => spare.id) }
  }
  await holding.confirm({ minRemainingMs: RELAY_INTENT_REQUEST_TIMEOUT_MS })
  return { relay: await mintIntentRelayEndpoint(intent, emailVerificationProfile(intent.secret)), spares: [] }
}

/**
 * The held section. Each pass reads the database again, because the last one
 * (or another process) may have changed the answer: its own attach, an attach on
 * another mailbox's row, or a refusal. A failed mint or attach throws and leaves
 * the intent, for the next connect to recover.
 */
async function provisionWebhook(integrationId: string, scope: string, holding: LeaseHolding): Promise<EmailWebhook | null> {
  for (let pass = 0; pass < MAX_PROVISION_PASSES; pass++) {
    const existing = await existingWebhook(integrationId, scope)
    if (existing !== undefined) return existing
    const own = await readInstallation(installation(integrationId))
    if (!own) return null
    if (own.intent && own.intent.scope !== scope) {
      await abandonIntent(integrationId, own.intent)
      continue
    }
    // Intents are per scope in effect: another mailbox's outstanding one is
    // recovered on its own row, and this one then shares the endpoint.
    const outstanding = own.intent ? own : await readInstallation(and(otherInstallation(integrationId), hasIntentIn(scope)))
    const intent = outstanding?.intent ?? await recordIntent(integrationId, scope)
    if (!intent) continue
    const rowId = outstanding?.id ?? integrationId
    const { relay, spares } = await endpointFor(intent, !!outstanding, holding)
    const attached = await attachIntent(rowId, intent.attemptId, { relay, secret: intent.secret })
    const unused = attached ? spares : [relay.endpointId, ...spares]
    if (unused.length) await retireEndpoints(rowId, intent, unused)
  }
  throw new IntegrationSetupError('The email webhook endpoint kept changing while it was being set up')
}

/**
 * The installation's endpoint and signing secret. The first connect with a
 * relay takes those of another mailbox in the same scope, or mints them; after
 * that the address is fixed. Null if the installation is gone.
 *
 * A connect that can't get the lease fails rather than mint without it, as does
 * one that loses it before minting: the connection uses the stream, and its next
 * connect tries again.
 */
export async function ensureEmailWebhook(integration: Pick<AgentIntegrationRecord, 'id' | 'createdByUserId'>): Promise<EmailWebhook | null> {
  const own = await readInstallation(installation(integration.id))
  if (!own) return null
  if (own.attached) return settleAttached(own)
  const scope = await integrationRelayScope(integration.createdByUserId ?? undefined)
  try {
    const wait = await mintLease.acquireWhenFree<EmailWebhook | null>(mintLease.key(digestKeyPart(scope)), {
      timeoutMs: MINT_LEASE_WAIT_MS,
      whileWaiting: () => existingWebhook(integration.id, scope),
    })
    if (!wait.acquired) return wait.result
    return await mintLease.hold(wait.lease, holding => provisionWebhook(integration.id, scope, holding))
  } catch (error) {
    if (error instanceof LeaseWaitTimeoutError) throw new IntegrationSetupError('Another connection is still setting up the email webhook endpoint')
    if (error instanceof LeaseLostError) throw new IntegrationSetupError('Lost the lease for setting up the email webhook endpoint')
    throw error
  }
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
