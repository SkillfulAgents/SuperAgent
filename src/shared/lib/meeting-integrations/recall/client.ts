import { z } from 'zod'
import { IntegrationPolicyError } from '../../agent-integrations/errors'
import type { RecallOwner, RecallTransport } from './transport'

/** https://docs.recall.ai/reference/bot_create */
export const recallBotSchema = z.object({
  id: z.string(),
  status_changes: z.array(z.object({
    code: z.string(),
    sub_code: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
    created_at: z.string(),
  })).default([]),
  recordings: z.array(z.object({
    id: z.string(),
    expires_at: z.string().nullable().optional(),
    media_shortcuts: z.object({
      video_mixed: z.object({
        data: z.object({ download_url: z.string().nullable().optional() }).nullable().optional(),
        status: z.object({ code: z.string() }).nullable().optional(),
      }).nullable().optional(),
    }).nullable().optional(),
  }).loose()).default([]),
}).loose()
export type RecallBot = z.infer<typeof recallBotSchema>

export class RecallApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export interface RecallCreateBotRequest {
  meeting_url: string
  bot_name: string
  output_media: { camera: { kind: 'webpage'; config: { url: string } } }
  variant?: Partial<Record<'zoom' | 'google_meet' | 'microsoft_teams', 'web' | 'web_4_core' | 'web_gpu'>>
  recording_config?: Record<string, unknown>
  automatic_leave?: Record<string, unknown>
}

/**
 * Thin, validated HTTP client over whichever transport the host has. Every
 * call is attributed to the person who owns the work (the meeting's creator),
 * because the platform bills bot time to them.
 */
export class RecallClient {
  constructor(private readonly transport: RecallTransport, private readonly owner: RecallOwner, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.transport.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: await this.transport.authorization(this.owner), Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}),
        },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      })
    } catch (error) {
      if (error instanceof IntegrationPolicyError) throw error
      throw new RecallApiError('Could not reach the meeting bot service. Please retry.', 503)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new RecallApiError(describeFailure(response.status, text), response.status)
    }
    if (response.status === 204) return schema.parse(undefined)
    return schema.parse(await response.json())
  }

  createBot(body: RecallCreateBotRequest): Promise<RecallBot> {
    return this.request('/bot/', recallBotSchema, { method: 'POST', body: JSON.stringify(body) })
  }

  getBot(id: string): Promise<RecallBot> {
    return this.request(`/bot/${encodeURIComponent(id)}/`, recallBotSchema)
  }

  async leaveCall(id: string): Promise<void> {
    await this.request(`/bot/${encodeURIComponent(id)}/leave_call/`, z.unknown(), { method: 'POST' })
  }

  async sendChatMessage(id: string, message: string): Promise<void> {
    await this.request(`/bot/${encodeURIComponent(id)}/send_chat_message/`, z.unknown(), { method: 'POST', body: JSON.stringify({ message }) })
  }
}

function describeFailure(status: number, body: string): string {
  if (status === 401 || status === 403) return 'The meeting bot service refused this account. Check the Platform connection.'
  if (status === 404) return 'The meeting bot service does not know this bot.'
  if (status === 402) return 'The Platform account cannot start a meeting bot right now (billing).'
  if (status === 429) return 'Too many meeting bot requests right now. Try again in a moment.'
  if (status === 507) return 'The meeting bot service has no capacity right now. Try again in a moment.'
  const detail = body.trim().slice(0, 300)
  return `Meeting bot request failed (${status})${detail ? `: ${detail}` : ''}`
}
