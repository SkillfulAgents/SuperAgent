import { z } from 'zod'
import { attribution } from '../platform-attribution'
import { getPlatformAccessToken } from '../services/platform-auth-service'
import { EMAIL_GATEWAY_URL, emailMessageSchema } from './config-schema'
import type { AgentIntegrationRecord } from '../agent-integrations/types'

export class EmailGatewayError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'EmailGatewayError' }
}
export async function emailBearer(ownerUserId: string | null): Promise<string> {
  if (!getPlatformAccessToken()) throw new EmailGatewayError(409, 'Connect Platform to use agent email')
  const auth = ownerUserId ? await attribution.fromUserId(ownerUserId) : await attribution.current()
  if (auth) return auth.bearerToken()
  // Single-user installations have no user row or ambient request during polling.
  if (!attribution.requiresActingMember()) return getPlatformAccessToken()!
  throw new EmailGatewayError(403, 'A Platform member identity is required for email')
}
export const mailboxSchema = z.object({ id: z.string().uuid(), address: z.string().email(), name: z.string(), status: z.string(), domain: z.object({ status: z.string(), error: z.string().nullable() }).optional() })
export const emailEventSchema = z.object({ cursor: z.number(), mailboxId: z.string(), type: z.string(), messageId: z.string().nullable(), data: z.unknown(), createdAt: z.number() })
export const emailEventsSchema = z.object({ data: z.array(emailEventSchema), cursor: z.number(), hasMore: z.boolean() })
export class EmailGatewayClient {
  constructor(readonly ownerUserId: string | null) {}
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await emailBearer(this.ownerUserId)}`)
    let response: Response
    try { response = await fetch(`${EMAIL_GATEWAY_URL}/v1${path}`, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(20000) }) }
    catch { throw new EmailGatewayError(503, 'Email gateway is unavailable. Please retry.') }
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null))
      throw new EmailGatewayError(response.status, error.success ? error.data.error : `Email gateway returned ${response.status}`)
    }
    return response
  }
  async json<T>(path: string, schema: z.ZodType<T>, body?: unknown, method = 'POST', key?: string): Promise<T> {
    const response = await this.request(path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) })
    return schema.parse(await response.json())
  }
  message(mailboxId: string, messageId: string) { return this.json(`/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`, emailMessageSchema) }
  async thread(mailboxId: string, threadId: string) {
    const schema = z.object({ messages: z.array(emailMessageSchema), cursor: z.number(), hasMore: z.boolean() })
    const messages: z.infer<typeof emailMessageSchema>[] = []
    let cursor = 0
    for (let page = 0; page < 100; page++) {
      const result = await this.json(`/mailboxes/${encodeURIComponent(mailboxId)}/threads/${encodeURIComponent(threadId)}?after=${cursor}`, schema)
      messages.push(...result.messages)
      if (!result.hasMore) return messages
      cursor = result.cursor
    }
    throw new Error('Email thread exceeds supported history size')
  }
}
export function clientFor(record: AgentIntegrationRecord) { return new EmailGatewayClient(record.createdByUserId) }
