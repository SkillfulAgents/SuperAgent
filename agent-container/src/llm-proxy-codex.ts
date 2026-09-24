import { Stream } from '@anthropic-ai/sdk/core/streaming'

type Json = Record<string, unknown>

/** Codex subscription serves Responses streams, with server-managed output limits. */
export function normalizeCodexRequest(body: Json): Json {
  const result: Json = { ...body, store: false, stream: true, instructions: body.instructions ?? '' }
  delete result.max_output_tokens
  delete result.service_tier
  return result
}

/** Non-streaming SDK helper requests still need a JSON reply (e.g. WebSearch).
 * The completed Responses event contains the full output, including reasoning.
 * Framing comes from the existing SDK; wire conversion stays in the shared codec.
 */
export async function collectCodexResponse(response: Response, abort: AbortController): Promise<Json> {
  let bytes = 0
  for await (const event of Stream.rawEvents(response, abort)) {
    bytes += Buffer.byteLength(event.data)
    if (bytes > 32 * 1024 * 1024) throw new Error('Codex response too large')
    const data = JSON.parse(event.data) as Json
    if (data.type === 'response.completed' || data.type === 'response.incomplete') {
      if (!data.response || typeof data.response !== 'object') throw new Error('Invalid completed response')
      return data.response as Json
    }
    if (data.type === 'response.failed' || data.type === 'error') throw new CodexResponseError(data)
  }
  throw new Error('Codex stream ended without a completed response')
}

/** Codex also uses a FastAPI-style detail envelope for unsupported models. */
export function normalizeCodexError(body: unknown): unknown {
  if (body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string') {
    return { error: { message: body.detail } }
  }
  return body
}

const record = (value: unknown): Json => value !== null && typeof value === 'object' ? value as Json : {}

/** Preserve completed SSE failures for callers expecting a JSON Messages reply. */
export class CodexResponseError extends Error {
  readonly status: number
  readonly body: Json
  readonly retryable: boolean
  constructor(event: Json) {
    const error = record(event.type === 'response.failed' ? record(event.response).error : event.error ?? event)
    const message = typeof error.message === 'string' ? error.message : 'Codex response failed'
    super(message)
    const code = String(error.code ?? error.type ?? '')
    const quota = ['usage_limit_reached', 'insufficient_quota', 'billing_hard_limit_reached'].includes(code)
    const knownStatus: Record<string, number> = {
      authentication_error: 401, invalid_api_key: 401, invalid_token: 401,
      permission_denied: 403, model_not_found: 404, unsupported_model: 400,
      invalid_request_error: 400, invalid_request: 400, rate_limit_exceeded: 429,
      rate_limit_error: 429, server_error: 502,
    }
    const explicit = error.status_code ?? error.status
    this.status = quota ? 429 : knownStatus[code] ?? (typeof explicit === 'number' && explicit >= 400 && explicit <= 599 ? explicit : 502)
    this.retryable = !quota && (this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500)
    this.body = { error: { ...error, message } }
  }
}
