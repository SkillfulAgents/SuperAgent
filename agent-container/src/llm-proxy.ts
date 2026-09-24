import { CredentialRefreshError } from './credential-refresh-error'
import { normalizeCodexRequest, collectCodexResponse, normalizeCodexError, CodexResponseError } from './llm-proxy-codex'
import { grokWireFormat } from './llm-proxy-grok'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { llmProxyConfigSchema, proxyCredentialSchema, type LlmProxyConfig, type ProxyCredential } from './llm-proxy-schema'
import { expandDeferredTools } from './llm-proxy-tools'

type Json = Record<string, unknown>
const requestSchema = z.object({ model: z.string().min(1), messages: z.array(z.unknown()), stream: z.boolean().optional() }).passthrough()
const MAX_BODY_BYTES = 32 * 1024 * 1024

export interface LlmProxyAdapter {
  // Provider-specific compatibility stays outside the shared wire codecs.
  request?(body: Json): Json
  upstreamRequest?(body: Json): Json
  messagesStream?(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>
}
export interface LlmProxyOptions {
  llmProviderId: string
  config: LlmProxyConfig
  adapter?: LlmProxyAdapter
  refreshCredential?: (current: ProxyCredential, rejected: boolean) => Promise<ProxyCredential>
}
export interface LlmProxyHandle {
  env: Record<string, string>
  updateCredential(value: ProxyCredential): void
  close(): Promise<void>
}

/** A loopback listener in the existing process, scoped to one SDK subprocess.
 * It cannot select accounts or arbitrary URLs from incoming request data.
 */
export async function startLlmProxy(options: LlmProxyOptions): Promise<LlmProxyHandle> {
  // Preserve a native ESM import when compiling the CommonJS container. Native
  // providers never load the translator or open a proxy listener.
  const {
    messagesRequestToResponses, responsesResponseToMessages, responsesStreamToMessagesStream,
    messagesRequestToChatCompletions, chatCompletionsResponseToMessages, chatCompletionsStreamToMessagesStream,
    responsesErrorToMessagesError, toolNameRestoreMap,
  } = await import('llm-endpoint-translation')
  const config = llmProxyConfigSchema.parse(options.config)
  let credential = config.credential
  let refreshing: Promise<ProxyCredential> | undefined
  let refreshFailure: { error: CredentialRefreshError; generation: number; retryAt: number } | undefined
  const key = randomBytes(32).toString('hex')
  const active = new Set<AbortController>()
  async function refresh(previous: ProxyCredential, rejected: boolean): Promise<void> {
    if (!options.refreshCredential) return
    if (credential !== previous) return
    if (refreshFailure?.generation === previous.generation && refreshFailure.retryAt > Date.now()) throw refreshFailure.error
    refreshing ??= options.refreshCredential(previous, rejected).then(value => {
      if (credential === previous) credential = proxyCredentialSchema.parse(value)
      return credential
    }).catch(error => {
      if (credential !== previous) return credential
      const safe = error instanceof CredentialRefreshError ? error : new CredentialRefreshError()
      refreshFailure = { error: safe, generation: previous.generation, retryAt: safe.status === 401 ? Infinity : Date.now() + 30_000 }
      throw safe
    }).finally(() => { refreshing = undefined })
    await refreshing
  }
  const server = createServer((req, res) => { void handle(req, res) })
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController()
    active.add(abort)
    res.on('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      if (req.headers['x-api-key'] !== key && req.headers.authorization !== `Bearer ${key}`) {
        sendError(res, 401, 'Invalid proxy credential'); return
      }
      if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/messages') {
        sendError(res, 404, 'Unsupported proxy endpoint'); return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) { sendError(res, 413, 'Request body too large'); return }
        chunks.push(Buffer.from(chunk))
      }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).toString()) } catch {
        sendError(res, 400, 'Invalid JSON'); return
      }
      const validated = requestSchema.safeParse(parsed)
      if (!validated.success) { sendError(res, 400, 'Invalid Messages request'); return }
      let body: Json = expandDeferredTools(validated.data)
      const format = config.adapter === 'grok' ? grokWireFormat(body) : config.format
      body = options.adapter?.request?.(body) ?? body
      const tools = Array.isArray(body.tools) ? body.tools as Json[] : []
      // Never silently drop hosted capabilities that the selected wire cannot execute.
      if (format !== 'messages' && tools.some(tool =>
        !tool.input_schema && !(format === 'responses' && String(tool.type).startsWith('web_search')))) {
        sendError(res, 400, 'This provider does not support the requested hosted tool; use an MCP tool instead'); return
      }
      if (config.maxOutputTokens && typeof body.max_tokens === 'number') {
        body = { ...body, max_tokens: Math.min(body.max_tokens, config.maxOutputTokens) }
      }
      const replyOptions = { model: validated.data.model, toolNames: toolNameRestoreMap(body), reasoningReplayScope: '' }
      const path = format === 'responses' ? '/responses' : format === 'chat-completions' ? '/chat/completions' : '/messages'
      const request = () => {
        const account = credential.accountId ?? createHash('sha256').update(credential.accessToken).digest('hex')
        // The codec reserves colons; rebuild the account-bound scope on auth retry.
        const scope = createHash('sha256').update(JSON.stringify([options.llmProviderId, account, config.baseUrl, body.model])).digest('hex')
        replyOptions.reasoningReplayScope = scope
        let upstreamBody = format === 'responses'
          ? messagesRequestToResponses(body, { reasoningReplayScope: scope,
            ...(config.omitReasoningEffort ? { mapReasoningEffort: () => undefined } : {}) }).body
          : format === 'chat-completions'
            ? messagesRequestToChatCompletions(body, {
              tokenLimitField: config.chatTokenLimitField,
              ...(config.omitReasoningEffort ? { mapReasoningEffort: () => undefined } : {}),
            }) : body
        upstreamBody = options.adapter?.upstreamRequest?.(upstreamBody) ?? upstreamBody
        if (config.adapter === 'codex') upstreamBody = normalizeCodexRequest(upstreamBody, req.headers['x-superagent-speed'] === 'fast')
        return fetch(`${config.baseUrl.replace(/\/$/, '')}${path}`, {
          method: 'POST', redirect: 'error', signal: abort.signal,
          headers: { 'content-type': 'application/json', ...(format === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
            ...config.headers, ...(config.adapter === 'codex' && credential.accountId ? { 'ChatGPT-Account-ID': credential.accountId } : {}), authorization: `Bearer ${credential.accessToken}` },
          body: JSON.stringify(upstreamBody),
        })
      }
      if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now() + 30_000) await refresh(credential, false)
      const sent = credential
      let upstream = await request()
      // Only a pre-stream authentication rejection may replay a request. No quota,
      // network or mid-stream retries, and the app remains the refresh authority.
      if (upstream.status === 401 && options.refreshCredential) {
        await upstream.body?.cancel()
        await refresh(sent, true)
        upstream = await request()
      }
      if (!upstream.ok) {
        const error = await upstream.json().catch(() => ({}))
        sendJson(res, upstream.status, responsesErrorToMessagesError(config.adapter === 'codex' ? normalizeCodexError(error) : error, upstream.status)); return
      }
      if (validated.data.stream) {
        if (!upstream.body) throw new Error('Missing upstream stream')
        const raw = format === 'responses' ? responsesStreamToMessagesStream(upstream.body, replyOptions)
          : format === 'chat-completions' ? chatCompletionsStreamToMessagesStream(upstream.body, replyOptions) : upstream.body
        const stream = format === 'messages' ? options.adapter?.messagesStream?.(raw) ?? raw : raw
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        await pipeline(Readable.fromWeb(stream as import('node:stream/web').ReadableStream<Uint8Array>), res)
      } else {
        const json = config.adapter === 'codex' ? await collectCodexResponse(upstream, abort) : await upstream.json() as Json
        sendJson(res, 200, format === 'responses' ? responsesResponseToMessages(json, replyOptions)
          : format === 'chat-completions' ? chatCompletionsResponseToMessages(json, replyOptions) : json)
      }
    } catch (error) {
      // Do not log bodies, URLs with credentials, headers, or upstream exceptions.
      abort.abort()
      if (res.headersSent) res.destroy()
      else if (!res.destroyed && error instanceof CodexResponseError) {
        if (!error.retryable) res.setHeader('x-should-retry', 'false')
        sendJson(res, error.status, responsesErrorToMessagesError(error.body, error.status))
      } else if (!res.destroyed) sendError(res, error instanceof CredentialRefreshError ? error.status : 502,
        error instanceof CredentialRefreshError ? error.message : 'Provider proxy request failed')
    } finally { active.delete(abort) }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Proxy listener unavailable')
  return {
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: key,
      ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    updateCredential(value) {
      const next = proxyCredentialSchema.parse(value)
      // A runtime snapshot can predate a refresh performed inside this proxy.
      if (next.generation > credential.generation) credential = next
    },
    async close() {
      for (const abort of active) abort.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function sendError(res: ServerResponse, status: number, message: string): void {
  const type = status === 401 ? 'authentication_error' : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 400 ? 'invalid_request_error' : 'api_error'
  sendJson(res, status, { type: 'error', error: { type, message } })
}

/** SDK process identity excludes rotating secrets, but includes account switches. */
export function llmProxyBinding(llmProviderId: string, proxy?: LlmProxyConfig): string | undefined {
  if (!proxy) return undefined
  const { credential, ...configuration } = proxy
  return JSON.stringify([llmProviderId, configuration, credential.accountId])
}
