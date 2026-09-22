import { captureException } from '../error-reporting'
import { createHash } from 'node:crypto'
import { platformConnected } from './policy'
import { watchEmail } from './live'
import { z } from 'zod'
import { EmailAgentIntegration, emailDefinition } from './email-agent-integration'
import { parseEmailConfig, emailMessageSchema, emailThreadStateSchema, type EmailSend } from './config-schema'
import { clientFor, emailEventsSchema, mailboxSchema } from './gateway-client'
import { emailThreadRoute, readEmailState, writeEmailState } from './state'
import type { AgentIntegrationRecord } from '../agent-integrations/types'

/** Standalone gateway transport; credentials are resolved from Platform for each request. */
export class PlatformEmailAgentIntegration extends EmailAgentIntegration {
  readonly provider = 'platform-email'
  protected isAvailable() { return platformConnected() }
  readonly definition = emailDefinition
  private readonly config
  private readonly client
  private connected = false
  private stopped = true
  private timer?: ReturnType<typeof setTimeout>
  private pending?: Promise<void>
  private unwatch?: () => void
  constructor(record: AgentIntegrationRecord) { super(record); this.config = parseEmailConfig(record.config); this.client = clientFor(record) }
  private get base() { return `/mailboxes/${encodeURIComponent(this.config.mailboxId)}` }
  async connect() {
    const identity = await this.client.json('/me', z.object({ orgId: z.string(), memberId: z.string() }))
    if (identity.orgId !== this.config.platformOrgId || identity.memberId !== this.config.platformMemberId) throw new Error('Reconnect the Platform account that owns this inbox')
    const mailbox = await this.client.json(this.base, mailboxSchema)
    if (mailbox.status === 'disabled') throw new Error('This inbox has been disabled')
    this.stopped = false
    this.connected = mailbox.domain?.status === 'ready'
    this.unwatch = watchEmail(this.record.createdByUserId, this.config.platformMemberId, this.record.id, this.config.mailboxId, () => {
      if (!this.stopped && !this.pending) { clearTimeout(this.timer); this.schedule(0) }
    })
    this.schedule(0)
  }
  private schedule(ms: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.pending = this.poll().catch(error => { this.connected = false; captureException(error, { tags: { component: 'email-integration', operation: 'poll' } }) }).finally(() => { this.pending = undefined; this.schedule(30000) })
    }, ms)
    this.timer.unref?.()
  }
  private async poll() {
    if (!this.connected) {
      const box = await this.client.json(this.base, mailboxSchema)
      if (box.domain?.status !== 'ready') return
      this.connected = true
    }
    let cursor = await readEmailState(this.record.id, 'cursor', z.number()) ?? 0
    for (let page = 0; page < 10 && !this.stopped; page++) {
      const result = await this.client.json(`/events?mailboxIds=${this.config.mailboxId}&after=${cursor}&limit=100`, emailEventsSchema)
      for (const event of result.data) {
        if (this.stopped) return
        if (event.type === 'thread.reconciled') {
          const merge = z.object({ fromThreadId: z.string(), toThreadId: z.string() }).parse(event.data)
          const oldRoute = await this.threadRoute(merge.fromThreadId)
          const newRoute = await this.threadRoute(merge.toThreadId)
          const oldState = await readEmailState(this.record.id, `thread:${oldRoute}`, emailThreadStateSchema)
          const newState = await readEmailState(this.record.id, `thread:${newRoute}`, emailThreadStateSchema)
          // Keep an existing inbound session when the canonical thread has no session yet.
          if (oldState && !newState && oldRoute !== newRoute) await writeEmailState(this.record.id, `route:${merge.toThreadId}`, z.string(), oldRoute)
        }
        const replay = event.type === 'thread.reconciled' && event.messageId && !await readEmailState(this.record.id, `accepted:${event.messageId}`, z.boolean())
        if ((event.type === 'message.received' || replay) && event.messageId) {
          const message = await this.getMessage(event.messageId)
          if (this.stopped) return
          await this.emitEvent({ type: 'input', id: replay ? `reconciled:${message.id}` : message.id, externalId: await this.threadRoute(message.threadId), timestamp: new Date(message.createdAt), payload: message })
        }
        // The shared manager durably accepts input before this provider advances its cursor.
        await writeEmailState(this.record.id, 'cursor', z.number(), event.cursor)
        cursor = event.cursor
      }
      if (!result.hasMore) return
    }
  }
  private threadRoute(id: string) { return emailThreadRoute(this.record.id, id) }
  async disconnect() { this.stopped = true; this.connected = false; this.unwatch?.(); clearTimeout(this.timer); await this.pending }
  isConnected() { return this.connected }
  protected getMessage(id: string) { return this.client.message(this.config.mailboxId, id) }
  protected getThread(id: string) { return this.client.thread(this.config.mailboxId, id) }
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
    const existing = await readEmailState(this.record.id, key, z.string())
    if (existing) return existing
    const response = await this.client.request(`${this.base}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': filename.replace(/[^\x20-\x7e]/g, '_') }, body: new Uint8Array(data) })
    const id = z.object({ id: z.string().uuid() }).parse(await response.json()).id
    await writeEmailState(this.record.id, key, z.string(), id)
    return id
  }
}
