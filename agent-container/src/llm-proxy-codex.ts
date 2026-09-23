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
    if (data.type === 'response.failed' || data.type === 'error') throw new Error('Codex response failed')
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
