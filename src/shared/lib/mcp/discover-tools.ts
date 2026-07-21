import type { McpToolInfo } from './types'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'
import { captureMessage } from '@shared/lib/error-reporting'

/**
 * Parse an MCP response that may be JSON or SSE (text/event-stream).
 * SSE responses contain lines like "event: message\ndata: {...}\n\n".
 */
export async function parseMcpResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    const text = await res.text()
    // Extract the last JSON-RPC message from SSE events
    const dataLines = text.split('\n').filter((line) => line.startsWith('data: '))
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const json = JSON.parse(dataLines[i].slice(6))
        if (json.result !== undefined || json.id !== undefined) {
          return json
        }
      } catch {
        continue
      }
    }
    throw new Error('No valid JSON-RPC response found in SSE stream')
  }
  return res.json()
}

/**
 * Connect to an MCP server, initialize, and discover available tools.
 * Throws on failure.
 *
 * This is the canonical Streamable-HTTP MCP handshake used both by the
 * /api/remote-mcps connect route and by tooling that needs to verify a server
 * speaks MCP. Kept in @shared so the two cannot drift.
 */
export async function discoverTools(url: string, accessToken?: string | null): Promise<McpToolInfo[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  const initRes = await mcpSafeFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Gamut', version: '1.0.0' },
      },
      id: 1,
    }),
  })

  if (!initRes.ok) {
    // TEMP DIAGNOSTIC (remove after debugging the Lifetimely 401): capture the
    // resource server's own error reason and the token's claims (NOT the raw
    // token — claims alone can't authenticate, so they're safe to log).
    let body = ''
    try { body = await initRes.text() } catch { /* ignore */ }
    const wwwAuth = initRes.headers.get('WWW-Authenticate')
    let claims: unknown = null
    if (accessToken) {
      const parts = accessToken.split('.')
      if (parts.length === 3) {
        try {
          claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
        } catch { /* not a JWT */ }
      }
    }
    const tokenType = accessToken ? (claims ? 'jwt' : 'opaque-or-unparsable') : 'none'
    const diagnostic = {
      url,
      status: initRes.status,
      wwwAuthenticate: wwwAuth,
      body: body.slice(0, 1000),
      tokenType,
      tokenClaims: claims,
    }
    console.error('[mcp/discover] initialize failed', diagnostic)
    captureMessage('MCP initialize failed during tool discovery', {
      level: 'warning',
      tags: {
        area: 'remote-mcp',
        op: 'discover-tools',
        status: String(initRes.status),
        tokenType,
      },
      extra: diagnostic,
      // Group every occurrence into one Sentry issue regardless of which
      // server/status, so it's easy to find while debugging.
      fingerprint: ['mcp-discover-initialize-failed'],
    })
    throw new Error(`Initialize failed: ${initRes.status}`)
  }

  await parseMcpResponse(initRes)
  const mcpSessionId = initRes.headers.get('Mcp-Session-Id')

  const toolHeaders: Record<string, string> = { ...headers }
  if (mcpSessionId) {
    toolHeaders['Mcp-Session-Id'] = mcpSessionId
  }

  await mcpSafeFetch(url, {
    method: 'POST',
    headers: toolHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  })

  const toolsRes = await mcpSafeFetch(url, {
    method: 'POST',
    headers: toolHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2,
    }),
  })

  if (!toolsRes.ok) {
    throw new Error(`Tools list failed: ${toolsRes.status}`)
  }

  const toolsBody = await parseMcpResponse(toolsRes) as {
    result?: { tools?: McpToolInfo[] }
  }
  return toolsBody.result?.tools || []
}
