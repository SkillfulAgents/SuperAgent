import * as http from 'http'
import * as crypto from 'crypto'

/**
 * A self-contained OAuth-protected MCP server for the live hot-add probe.
 *
 * One process plays all three roles the host's OAuth-first connect flow
 * expects of a real remote MCP:
 *
 *  - the MCP resource server (`POST /mcp`, Streamable HTTP, JSON responses)
 *    that answers 401 + `WWW-Authenticate: Bearer resource_metadata=...`
 *    until it sees one of its own bearer tokens;
 *  - RFC 9728 protected-resource metadata and RFC 8414 authorization-server
 *    metadata under `/.well-known/`;
 *  - the authorization server itself: RFC 7591 dynamic client registration,
 *    an HTML login page at `/authorize` (this is the "log in to the MCP" step
 *    a person sees in the popup), and a PKCE-checked `/token` endpoint.
 *
 * Everything is in memory and every request is logged to `events` so a spec
 * can assert the exact sequence: registration → login → token → tools/call
 * carrying the issued token.
 */
export interface MockOAuthMcp {
  origin: string
  mcpUrl: string
  port: number
  /** Login the page accepts. */
  credentials: { username: string; password: string }
  /** Tool calls the resource server received, in order, with the bearer they carried. */
  toolCalls: Array<{ name: string; arguments?: Record<string, unknown>; bearer: string | null }>
  /** Access tokens issued by /token. */
  tokensIssued: string[]
  /** Chronological log of notable requests. */
  events: string[]
  close: () => Promise<void>
}

export interface MockOAuthMcpOptions {
  port?: number
  serverName?: string
  username?: string
  password?: string
  /** What `get_launch_code` returns — pick something a model cannot guess. */
  launchCode?: string
}

const html = (body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Rocket Ops — Sign in</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1e293b; padding: 32px 36px; border-radius: 12px; width: 340px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
  h1 { font-size: 20px; margin: 0 0 4px; } p { margin: 0 0 20px; color: #94a3b8; font-size: 14px; }
  label { display: block; font-size: 12px; color: #94a3b8; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 14px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 8px; background: #f97316; color: white; font-weight: 600; font-size: 14px; cursor: pointer; }
  .err { color: #f87171; font-size: 13px; margin-top: 10px; }
</style></head><body><div class="card">${body}</div></body></html>`

export async function startMockOAuthMcp(options: MockOAuthMcpOptions = {}): Promise<MockOAuthMcp> {
  const serverName = options.serverName ?? 'Rocket Ops'
  const credentials = {
    username: options.username ?? 'mission-control',
    password: options.password ?? 'liftoff-2026',
  }
  const launchCode = options.launchCode ?? 'RKT-4242-ORBIT'

  const clients = new Map<string, { redirectUris: string[] }>()
  const codes = new Map<string, { clientId: string; redirectUri: string; codeChallenge: string; resource?: string }>()
  const tokens = new Set<string>()
  const toolCalls: MockOAuthMcp['toolCalls'] = []
  const tokensIssued: string[] = []
  const events: string[] = []
  let origin = ''

  const tools = [
    {
      name: 'get_launch_code',
      description: `Returns today's launch authorization code for the ${serverName} mission board.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_missions',
      description: 'Lists the missions currently on the board.',
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    },
  ]

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => resolve(body))
    })

  const json = (res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  }

  const bearerOf = (req: http.IncomingMessage): string | null => {
    const auth = req.headers.authorization
    if (!auth || !/^Bearer\s+/i.test(auth)) return null
    return auth.replace(/^Bearer\s+/i, '').trim()
  }

  const server = http.createServer(async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', origin)
    } catch {
      res.writeHead(400); res.end(); return
    }
    const route = `${req.method} ${url.pathname}`

    // ── MCP resource server ────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        // No server-initiated stream: the spec lets a server answer 405 and
        // clients carry on with request/response.
        res.writeHead(405); res.end(); return
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return }
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

      const bearer = bearerOf(req)
      const body = await readBody(req)
      let rpc: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {}
      try { rpc = JSON.parse(body) } catch { /* fall through with an empty rpc */ }

      if (!bearer || !tokens.has(bearer)) {
        events.push(`mcp:${rpc.method ?? '?'}:401`)
        json(res, 401, { error: 'unauthorized' }, {
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        })
        return
      }

      const reply = (result: unknown) => json(res, 200, { jsonrpc: '2.0', id: rpc.id, result })
      switch (rpc.method) {
        case 'initialize':
          events.push('mcp:initialize:ok')
          reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.0.0' } })
          return
        case 'notifications/initialized':
          res.writeHead(202); res.end(); return
        case 'ping':
          reply({}); return
        case 'tools/list':
          events.push('mcp:tools/list')
          reply({ tools }); return
        case 'tools/call': {
          const name = rpc.params?.name ?? ''
          toolCalls.push({ name, arguments: rpc.params?.arguments, bearer })
          events.push(`mcp:tools/call:${name}`)
          if (name === 'get_launch_code') {
            reply({ content: [{ type: 'text', text: `Launch authorization code for today: ${launchCode}` }] })
          } else if (name === 'list_missions') {
            reply({ content: [{ type: 'text', text: 'Missions: Artemis-7 (go), Kestrel-2 (hold)' }] })
          } else {
            json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: `Unknown tool ${name}` } })
          }
          return
        }
        default:
          json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
          return
      }
    }

    // ── Discovery metadata ─────────────────────────────────────────────
    if (route === 'GET /.well-known/oauth-protected-resource') {
      events.push('discovery:protected-resource')
      json(res, 200, { resource: origin, authorization_servers: [origin], scopes_supported: ['missions:read'] })
      return
    }
    if (route === 'GET /.well-known/oauth-authorization-server') {
      events.push('discovery:authorization-server')
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['missions:read'],
      })
      return
    }

    // ── Authorization server ───────────────────────────────────────────
    if (route === 'POST /register') {
      let body: { client_name?: string; redirect_uris?: string[] }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(res, 400, { error: 'invalid_client_metadata' }); return
      }
      const clientId = `rocket-${crypto.randomBytes(6).toString('hex')}`
      clients.set(clientId, { redirectUris: body.redirect_uris ?? [] })
      events.push(`register:${body.client_name ?? '?'}`)
      json(res, 201, {
        client_id: clientId,
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
      return
    }

    if (route === 'GET /authorize') {
      const p = url.searchParams
      const client = clients.get(p.get('client_id') ?? '')
      const redirectUri = p.get('redirect_uri') ?? ''
      if (!client || !client.redirectUris.includes(redirectUri)) {
        events.push('authorize:invalid_redirect_uri')
        json(res, 400, { error: 'invalid_redirect_uri' })
        return
      }
      if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
        json(res, 400, { error: 'invalid_request' })
        return
      }
      events.push('authorize:login-page')
      const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'resource', 'scope']
        .map((k) => `<input type="hidden" name="${k}" value="${escapeAttr(p.get(k) ?? '')}">`)
        .join('')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html(`
        <h1>🚀 ${serverName}</h1>
        <p>Sign in to let <strong>Gamut</strong> read your mission board.</p>
        <form method="POST" action="/login" data-testid="login-form">
          ${hidden}
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="off" data-testid="login-username">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" data-testid="login-password">
          <button type="submit" data-testid="login-submit">Sign in &amp; authorize</button>
        </form>`))
      return
    }

    if (route === 'POST /login') {
      const form = new URLSearchParams(await readBody(req))
      const clientId = form.get('client_id') ?? ''
      const redirectUri = form.get('redirect_uri') ?? ''
      if (form.get('username') !== credentials.username || form.get('password') !== credentials.password) {
        events.push('login:rejected')
        res.writeHead(401, { 'Content-Type': 'text/html' })
        res.end(html(`<h1>🚀 ${serverName}</h1><p class="err" data-testid="login-error">Wrong username or password.</p><a href="javascript:history.back()">Try again</a>`))
        return
      }
      const code = crypto.randomBytes(16).toString('hex')
      codes.set(code, {
        clientId,
        redirectUri,
        codeChallenge: form.get('code_challenge') ?? '',
        resource: form.get('resource') ?? undefined,
      })
      events.push('login:ok')
      let back: URL
      try {
        back = new URL(redirectUri)
      } catch {
        json(res, 400, { error: 'invalid_redirect_uri' }); return
      }
      back.searchParams.set('code', code)
      if (form.get('state')) back.searchParams.set('state', form.get('state')!)
      res.writeHead(302, { Location: back.toString() })
      res.end()
      return
    }

    if (route === 'POST /token') {
      const form = new URLSearchParams(await readBody(req))
      if (form.get('grant_type') !== 'authorization_code') {
        json(res, 400, { error: 'unsupported_grant_type' }); return
      }
      const grant = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      const verifier = form.get('code_verifier') ?? ''
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
      if (!grant || grant.clientId !== form.get('client_id') || grant.redirectUri !== form.get('redirect_uri') || grant.codeChallenge !== challenge) {
        events.push('token:invalid_grant')
        json(res, 400, { error: 'invalid_grant', error_description: 'code, client, redirect or PKCE verifier did not match' })
        return
      }
      const accessToken = `rkt_${crypto.randomBytes(18).toString('hex')}`
      tokens.add(accessToken)
      tokensIssued.push(accessToken)
      events.push('token:issued')
      json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `rkt_refresh_${crypto.randomBytes(8).toString('hex')}`,
        scope: 'missions:read',
      })
      return
    }

    if (route === 'GET /__probe') {
      json(res, 200, { toolCalls, tokensIssued: tokensIssued.length, events })
      return
    }

    res.writeHead(404); res.end()
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
      origin = `http://127.0.0.1:${port}`
      resolve({
        origin,
        mcpUrl: `${origin}/mcp`,
        port,
        credentials,
        toolCalls,
        tokensIssued,
        events,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
