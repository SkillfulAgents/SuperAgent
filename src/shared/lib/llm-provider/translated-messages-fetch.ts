import { createHash } from 'node:crypto'
import { z } from 'zod'
import { expandDeferredTools } from '../../../../agent-container/src/llm-proxy-tools'

interface TranslationOptions {
  headers?: Record<string, string>
  upstreamRequest?: (body: Record<string, unknown>) => Record<string, unknown>
}

/** Host-side helpers and dashboard shims use the same wire codecs as agents. */
export function translatedMessagesFetch(baseUrl: string, apiKey: string, format: 'chat-completions' | 'responses', tokenLimitField: 'max_tokens' | 'max_completion_tokens' = 'max_completion_tokens', translation: TranslationOptions = {}): typeof fetch {
  return async (input, init) => {
    let pathname: string
    try { pathname = new URL(input instanceof Request ? input.url : String(input)).pathname }
    catch { return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid Messages URL' } }, { status: 400 }) }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method !== 'POST' || !pathname.endsWith('/messages')) {
      return Response.json({ type: 'error', error: { type: 'not_found_error', message: 'Only Messages requests are supported by this translator' } }, { status: 404 })
    }
    const {
      messagesRequestToResponses, responsesResponseToMessages, responsesStreamToMessagesStream,
      messagesRequestToChatCompletions, chatCompletionsResponseToMessages, chatCompletionsStreamToMessagesStream,
      responsesErrorToMessagesError, toolNameRestoreMap,
    } = await import('llm-endpoint-translation')
    let parsed: unknown
    try { parsed = JSON.parse(String(init?.body)) } catch { throw new Error('Invalid Messages request') }
    const body = expandDeferredTools(z.object({ model: z.string(), messages: z.array(z.unknown()), stream: z.boolean().optional() }).passthrough().parse(parsed))
    const tools = Array.isArray(body.tools) ? body.tools as Record<string, unknown>[] : []
    if (tools.some(tool => !tool.input_schema && !(format === 'responses' && String(tool.type).startsWith('web_search')))) {
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'This provider does not support the requested hosted tool; use an MCP tool instead' } }, { status: 400 })
    }
    const scope = createHash('sha256').update(JSON.stringify([baseUrl, apiKey, body.model])).digest('hex')
    const options = { model: String(body.model), toolNames: toolNameRestoreMap(body), reasoningReplayScope: scope }
    const translated = format === 'responses'
      ? messagesRequestToResponses(body, { reasoningReplayScope: scope }).body
      : messagesRequestToChatCompletions(body, { tokenLimitField })
    const response = await fetch(`${baseUrl}/${format === 'responses' ? 'responses' : 'chat/completions'}`, {
      method: 'POST', redirect: 'error', signal: init?.signal,
      headers: { 'content-type': 'application/json', ...translation.headers, authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(translation.upstreamRequest?.(translated) ?? translated),
    })
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => ({}))
      return Response.json(responsesErrorToMessagesError(error, response.status), { status: response.status })
    }
    if (body.stream) {
      if (!response.body) throw new Error('Missing upstream stream')
      return new Response(format === 'responses'
        ? responsesStreamToMessagesStream(response.body, options)
        : chatCompletionsStreamToMessagesStream(response.body, options), { headers: { 'content-type': 'text/event-stream' } })
    }
    const result = z.record(z.string(), z.unknown()).parse(await response.json())
    return Response.json(format === 'responses' ? responsesResponseToMessages(result, options) : chatCompletionsResponseToMessages(result, options))
  }
}
