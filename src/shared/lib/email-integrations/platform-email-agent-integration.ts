import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { chatIntegrations } from '../db/schema'
import { getAgentIntegration } from '../services/agent-integration-service'
import { EMAIL_HISTORY_THREAD_LIMIT } from './directory'
import { captureException } from '../error-reporting'
import { background } from '../background'
import { createHash } from 'node:crypto'
import { platformConnected } from './policy'
import { watchEmail } from './live'
import { z } from 'zod'
import { EmailAgentIntegration, emailDefinition } from './email-agent-integration'
import { parseEmailConfig, emailConfigSchema, emailMessageSchema, type EmailSend } from './config-schema'
import { clientFor, emailEventsSchema, mailboxSchema } from './gateway-client'
import { emailThreadRoute } from './routing'
import { emailRelays, ensureEmailWebhook, type EmailRelays, type EmailWebhook } from './webhooks'
import { IntegrationSetupError } from '../agent-integrations/setup-types'
import type { IntegrationRelayAttachment } from '../agent-integrations/transport'
import type { AgentIntegrationRecord } from '../agent-integrations/types'

/**
 * Standalone gateway transport; credentials are resolved from Platform for each request.
 *
 * The cursor poll is the source of truth: it runs on connect, every 30s and on
 * each wake-up. Wake-ups come through the webhook relay when the host has one
 * as this connection starts, and then no stream is opened; otherwise they come
 * from the member's shared SSE stream (live.ts). See webhooks.ts.
 */
export class PlatformEmailAgentIntegration extends EmailAgentIntegration {
  static override isAvailable() { return platformConnected() }
  readonly provider = 'platform-email'
  protected isAvailable() { return platformConnected() }
  readonly definition = emailDefinition
  private readonly config
  private readonly client
  private connected = false
  private stopped = true
  /** Bumped by each connect and disconnect; a connect that was overtaken stands down. */
  private generation = 0
  /** How this connection is woken, chosen as it connects. */
  private mode: 'stream' | 'webhooks' | null = null
  private relayAttachment?: IntegrationRelayAttachment
  private timer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private uploads = new Map<string, string>()
  private unwatch?: () => void
  constructor(record: AgentIntegrationRecord, private readonly relays: EmailRelays = emailRelays) { super(record); this.config = parseEmailConfig(record.config); this.client = clientFor(record) }
  private get base() { return `/mailboxes/${encodeURIComponent(this.config.mailboxId)}` }
  async connect() {
    const generation = ++this.generation
    const identity = await this.client.json('/me', z.object({ orgId: z.string(), memberId: z.string() }))
    if (identity.orgId !== this.config.platformOrgId || identity.memberId !== this.config.platformMemberId) throw new Error('Reconnect the Platform account that owns this inbox')
    const mailbox = await this.client.json(this.base, mailboxSchema)
    if (mailbox.status === 'disabled') throw new Error('This inbox has been disabled')
    if (mailbox.domain?.status === 'failed') throw new Error(`Email domain setup failed${mailbox.domain.error ? ` (${mailbox.domain.error})` : ''}. Contact support.`)
    // Webhooks whenever the host has a relay as this connection starts; the
    // stream otherwise, or if webhooks can't be set up right now.
    const webhook = this.host.relay ? await this.registerWebhook() : null
    if (generation !== this.generation) return
    this.stopped = false
    this.connected = mailbox.domain?.status === 'ready'
    this.mode = webhook ? 'webhooks' : 'stream'
    if (webhook) this.relayAttachment = this.relays.attach(webhook, this.config.mailboxId, cursor => this.catchUp(cursor))
    else this.unwatch = watchEmail(this.record.createdByUserId, this.config.platformMemberId, this.record.id, this.config.mailboxId, () => { background(this.pollNow(), { name: 'platform-email.poll' }) })
    this.schedule(0)
  }
  /** Registers the relay endpoint as this mailbox's gateway webhook. Null leaves this connection to the stream. */
  private async registerWebhook(): Promise<EmailWebhook | null> {
    try {
      const webhook = await ensureEmailWebhook(this.record)
      if (!webhook) return null
      // Every connect: the gateway deletes a webhook whose endpoint answered
      // 404/410 or failed for 72 hours, and an identical one changes nothing.
      await this.client.json(`${this.base}/webhook`, z.object({ webhook: z.object({ url: z.string() }).loose() }), { url: webhook.relay.url, secret: webhook.secret }, 'PUT')
      return webhook
    } catch (error) {
      if (error instanceof IntegrationSetupError) console.warn(`[PlatformEmailAgentIntegration] Using the stream for ${this.record.id}: ${error.message}`)
      else captureException(error, { tags: { component: 'email-integration', operation: 'webhooks' }, extra: { integrationId: this.record.id } })
      return null
    }
  }
  /** Runs a poll now, or joins the one running; the next timed poll is 30s after it ends. */
  private pollNow(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pending) return this.pending
    clearTimeout(this.timer)
    this.pending = this.poll()
      .catch(error => { this.connected = false; captureException(error, { tags: { component: 'email-integration', operation: 'poll' } }) })
      .finally(() => { this.pending = undefined; this.schedule(30000) })
    return this.pending
  }
  private schedule(ms: number) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { background(this.pollNow(), { name: 'platform-email.poll' }) }, ms)
    this.timer.unref?.()
  }
  /** A relayed pointer: polls until the stored cursor reaches it, at most twice (a running poll may predate it). */
  private async catchUp(cursor: number): Promise<number> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reached = await this.storedCursor()
      if (reached >= cursor || this.stopped) return reached
      await this.pollNow()
    }
    return this.storedCursor()
  }
  private async storedCursor() {
    const current = await getAgentIntegration(this.record.id)
    return current ? parseEmailConfig(current.config).eventCursor : -1
  }
  private async poll() {
    if (!this.connected) {
      const box = await this.client.json(this.base, mailboxSchema)
      if (box.domain?.status !== 'ready') return
      this.connected = true
    }
    const current = await getAgentIntegration(this.record.id)
    if (!current) return
    let cursor = parseEmailConfig(current.config).eventCursor
    for (let page = 0; page < 10 && !this.stopped; page++) {
      const result = await this.client.json(`/events?mailboxIds=${this.config.mailboxId}&after=${cursor}&limit=100`, emailEventsSchema)
      for (const event of result.data) {
        if (this.stopped) return
        if (event.type === 'message.received' && event.messageId) {
          const message = await this.getMessage(event.messageId)
          if (this.stopped) return
          const handoff = await this.emitEvent({ type: 'input', id: message.id, externalId: await this.threadRoute(message.threadId), timestamp: new Date(message.createdAt), payload: message })
          // Not taken: this connection was replaced or stopped while it polled.
          // Leave the cursor here so the connection that replaces it reads this
          // message again, instead of skipping it for good.
          if (handoff === 'retry') return
        }
        // The shared manager durably accepts input before this provider advances its cursor.
        const checkpoint = emailConfigSchema.shape.eventCursor.parse(event.cursor)
        // Update only the cursor so concurrent settings edits cannot be lost.
        await db.update(chatIntegrations).set({ config: sql`json_set(${chatIntegrations.config}, '$.eventCursor', ${checkpoint})` })
          .where(and(eq(chatIntegrations.id, this.record.id), sql`coalesce(json_extract(${chatIntegrations.config}, '$.eventCursor'), 0) < ${checkpoint}`)).run()
        cursor = event.cursor
      }
      if (!result.hasMore) return
    }
  }
  private threadRoute(id: string) { return emailThreadRoute(this.record, id) }
  async disconnect() {
    this.generation++
    this.stopped = true; this.connected = false; this.mode = null
    this.unwatch?.(); this.unwatch = undefined
    this.relayAttachment?.detach(); this.relayAttachment = undefined
    clearTimeout(this.timer); await this.pending
  }
  isConnected() { return this.connected }
  activeTransport() {
    if (!this.connected) return null
    return this.mode === 'webhooks' ? 'relay' as const : this.mode === 'stream' ? 'direct' as const : null
  }
  protected getMessage(id: string) { return this.client.message(this.config.mailboxId, id) }
  protected getThread(id: string) { return this.client.thread(this.config.mailboxId, id) }
  protected async recentHistory() {
    const page = await this.client.json(`${this.base}/threads?limit=${EMAIL_HISTORY_THREAD_LIMIT + 1}`, z.object({ data: z.array(z.object({ id: z.string() })) }))
    const threads = []
    let truncated = page.data.length > EMAIL_HISTORY_THREAD_LIMIT
    const selected = page.data.slice(0, EMAIL_HISTORY_THREAD_LIMIT)
    for (let offset = 0; offset < selected.length; offset += 5) {
      // Bound gateway concurrency and history; do not fetch entire large archives.
      const results = await Promise.all(selected.slice(offset, offset + 5).map(thread =>
        this.client.json(`${this.base}/threads/${encodeURIComponent(thread.id)}?after=0`, z.object({ messages: z.array(emailMessageSchema), hasMore: z.boolean() }))))
      for (const result of results) {
        truncated ||= result.hasMore
        threads.push(result.messages)
      }
    }
    return { threads, truncated }
  }
  protected submit(input: EmailSend) {
    const { idempotencyKey, ...body } = input
    return this.client.json(`${this.base}/messages`, emailMessageSchema, body, 'POST', idempotencyKey)
  }
  protected async downloadAttachment(id: string) {
    const response = await this.client.request(`${this.base}/attachments/${encodeURIComponent(id)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Attachment exceeds limit')
    return bytes
  }
  protected async uploadAttachment(data: Buffer, filename: string) {
    if (data.length > 5 * 1024 * 1024) throw new Error('Attachment exceeds 5 MiB')
    const key = `upload:${createHash('sha256').update(filename).update(data).digest('hex')}`
    const existing = this.uploads.get(key)
    if (existing) return existing
    const response = await this.client.request(`${this.base}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': filename.replace(/[^\x20-\x7e]/g, '_') }, body: new Uint8Array(data) })
    const id = z.object({ id: z.string().uuid() }).parse(await response.json()).id
    if (this.uploads.size >= 100) this.uploads.delete(this.uploads.keys().next().value!)
    this.uploads.set(key, id)
    return id
  }
}
