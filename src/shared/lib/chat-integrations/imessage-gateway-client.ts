/**
 * The iMessage gateway's HTTP API: the phone's webhook, and the commands a
 * host sends without a socket. The gateway's `docs/webhooks.md` and
 * `docs/http-api.md` describe both.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { IMessageConfig } from './config-schema'

export type GatewayCredentials = Pick<IMessageConfig, 'gatewayUrl' | 'phoneNumber' | 'token'>

export interface GatewayMessagePart {
  type: string
  value?: string
  attachmentId?: string
}

export class GatewayRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message)
    this.name = 'GatewayRequestError'
  }

  /** The request may succeed if repeated: unreachable, busy, or failing upstream. */
  get retryable(): boolean {
    return this.status === null || this.status === 409 || this.status === 429 || this.status >= 500
  }
}

async function gatewayRequest(config: GatewayCredentials, method: string, path: string, body?: unknown): Promise<Response> {
  const url = `${config.gatewayUrl.replace(/\/+$/, '')}/v1/phones/${encodeURIComponent(config.phoneNumber)}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new GatewayRequestError(`iMessage gateway unreachable: ${error instanceof Error ? error.message : String(error)}`, null)
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    throw new GatewayRequestError(`iMessage gateway answered ${method} ${path} with HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
  }
  return response
}

// ── Webhook ─────────────────────────────────────────────────────────────

const gatewayWebhookSchema = z.object({
  url: z.string(),
  events: z.array(z.string()),
  lastDeliveryAt: z.string().nullish(),
  lastError: z.object({ at: z.string(), message: z.string() }).nullish(),
  pending: z.number().optional(),
  parked: z.number().optional(),
}).loose()
export type GatewayWebhook = z.infer<typeof gatewayWebhookSchema>

/**
 * Points the phone's webhook at `url`, replacing whatever was there. The
 * secret goes with it, so an identical call changes nothing; it also resets
 * the gateway's backoff and retries events it held or parked.
 */
export async function registerGatewayWebhook(config: GatewayCredentials, webhook: { url: string; secret: string; events: readonly string[] }): Promise<GatewayWebhook> {
  const response = await gatewayRequest(config, 'PUT', '/webhook', webhook)
  return gatewayWebhookSchema.parse(await response.json())
}

/** The gateway holds events for a socket again. Succeeds when none was registered. */
export async function deleteGatewayWebhook(config: GatewayCredentials): Promise<void> {
  try {
    await gatewayRequest(config, 'DELETE', '/webhook')
  } catch (error) {
    if (!(error instanceof GatewayRequestError && error.status === 404)) throw error
  }
}

// ── Commands ────────────────────────────────────────────────────────────

const sentMessageSchema = z.object({ messageId: z.string().nullable(), chatId: z.string().nullable() })
export type GatewaySentMessage = z.infer<typeof sentMessageSchema>

/** Waits between attempts at one send; the idempotency key keeps a repeat from sending twice. */
export const SEND_RETRY_DELAYS_MS = [1_000, 3_000]

/**
 * Sends a message and resolves to Linq's id for it, which reactions to it
 * carry. Repeated under one idempotency key while the gateway or Linq is
 * unavailable, so it is sent at most once.
 */
export async function sendGatewayMessage(config: GatewayCredentials, message: { chatId?: string; parts: GatewayMessagePart[] }): Promise<GatewaySentMessage> {
  const body = { ...message, idempotencyKey: randomUUID() }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await gatewayRequest(config, 'POST', '/messages', body)
      return sentMessageSchema.parse(await response.json())
    } catch (error) {
      if (!(error instanceof GatewayRequestError && error.retryable) || attempt >= SEND_RETRY_DELAYS_MS.length) throw error
      await new Promise(resolve => setTimeout(resolve, SEND_RETRY_DELAYS_MS[attempt]))
    }
  }
}

export async function sendGatewayReaction(config: GatewayCredentials, reaction: { messageId: string; reactionType: string; partIndex: number }): Promise<void> {
  await gatewayRequest(config, 'POST', '/reactions', { ...reaction, operation: 'add' })
}

export async function startGatewayTyping(config: GatewayCredentials, chatId: string): Promise<void> {
  await gatewayRequest(config, 'POST', '/typing', { chatId })
}

export async function markGatewayChatRead(config: GatewayCredentials, chatId: string): Promise<void> {
  await gatewayRequest(config, 'POST', '/read', { chatId })
}

const uploadSchema = z.object({
  attachmentId: z.string(),
  uploadUrl: z.string(),
  downloadUrl: z.string(),
  requiredHeaders: z.record(z.string(), z.string()),
}).loose()
export type GatewayUpload = z.infer<typeof uploadSchema>

/** Where to upload a file before sending it as an attachment part. */
export async function requestGatewayUpload(config: GatewayCredentials, file: { filename: string; contentType: string; sizeBytes: number }): Promise<GatewayUpload> {
  const response = await gatewayRequest(config, 'POST', '/attachments', file)
  return uploadSchema.parse(await response.json())
}
