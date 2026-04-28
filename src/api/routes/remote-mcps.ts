import { Hono } from 'hono'
import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { remoteMcpServers } from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { initiateOAuthFlow, initiateNewServerOAuth, completeOAuthFlow, discoverOAuthMetadata } from '@shared/lib/mcp/oauth'
import type { McpToolInfo } from '@shared/lib/mcp/types'
import { getAppBaseUrlFromRequest, getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { Authenticated, UsersMcpServer, IsAdmin, Or } from '../middleware/auth'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

function safeParseTools(json: string | null): McpToolInfo[] {
  if (!json) return []
  try {
    return JSON.parse(json)
  } catch {
    return []
  }
}

/** Strip sensitive fields before sending to the frontend. */
function sanitizeServer(server: typeof remoteMcpServers.$inferSelect) {
  return {
    ...server,
    accessToken: undefined,
    refreshToken: undefined,
    oauthClientSecret: undefined,
    tools: safeParseTools(server.toolsJson),
  }
}

/**
 * Escape a string for safe inclusion in HTML content
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

const remoteMcps = new Hono()

remoteMcps.use('*', Authenticated())

/**
 * Parse an MCP response that may be JSON or SSE (text/event-stream).
 * SSE responses contain lines like "event: message\ndata: {...}\n\n".
 */
async function parseMcpResponse(res: Response): Promise<unknown> {
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
 */
async function discoverTools(url: string, accessToken?: string | null): Promise<McpToolInfo[]> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  const initRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Superagent', version: '1.0.0' },
      },
      id: 1,
    }),
  })

  if (!initRes.ok) {
    throw new Error(`Initialize failed: ${initRes.status}`)
  }

  await parseMcpResponse(initRes)
  const mcpSessionId = initRes.headers.get('Mcp-Session-Id')

  const toolHeaders: Record<string, string> = { ...headers }
  if (mcpSessionId) {
    toolHeaders['Mcp-Session-Id'] = mcpSessionId
  }

  await fetch(url, {
    method: 'POST',
    headers: toolHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  })

  const toolsRes = await fetch(url, {
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

// List remote MCP servers (scoped to user in auth mode)
remoteMcps.get('/', async (c) => {
  let query = db.select().from(remoteMcpServers).orderBy(remoteMcpServers.createdAt).$dynamic()

  if (isAuthMode()) {
    query = query.where(eq(remoteMcpServers.userId, getCurrentUserId(c)))
  }

  const servers = await query
  return c.json({
    servers: servers.map(sanitizeServer),
  })
})

// Register a new MCP server
remoteMcps.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    url: string
    authType?: 'none' | 'oauth' | 'bearer'
    accessToken?: string
  }>()

  if (!body.name?.trim() || !body.url?.trim()) {
    return c.json({ error: 'Name and URL are required' }, 400)
  }

  const authType = body.authType || 'none'

  if (authType === 'oauth') {
    return c.json({ error: 'OAuth servers must be added via /initiate-oauth' }, 400)
  }

  // Verify connection and discover tools before saving
  let tools: McpToolInfo[] = []
  try {
    tools = await discoverTools(body.url.trim(), body.accessToken || null)
  } catch (error: any) {
    // Check if the failure is a 401 — the server likely requires authentication
    if (error.message?.includes('401')) {
      const discovery = await discoverOAuthMetadata(body.url.trim())
      if (discovery) {
        return c.json({ error: 'This MCP server requires OAuth authentication', needsOAuth: true }, 400)
      }
      // No OAuth metadata — server likely needs a bearer token
      return c.json({ error: 'This MCP server requires authentication. Try adding a bearer token.', needsAuth: true }, 400)
    }
    return c.json({ error: `Failed to connect to MCP server: ${error.message}` }, 502)
  }

  const now = new Date()
  const id = crypto.randomUUID()

  await db.insert(remoteMcpServers).values({
    id,
    name: body.name.trim(),
    url: body.url.trim(),
    userId: getCurrentUserId(c),
    authType,
    accessToken: body.accessToken || null,
    toolsJson: JSON.stringify(tools),
    toolsDiscoveredAt: now,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })

  const [server] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  return c.json({
    server: sanitizeServer(server),
  }, 201)
})

// Initiate OAuth flow for an MCP server (existing or new)
remoteMcps.post('/initiate-oauth', async (c) => {
  const body = await c.req.json<{
    mcpId?: string
    name?: string
    url?: string
    electron?: boolean
    clientName?: string
  }>()

  const clientNameOverride =
    typeof body.clientName === 'string' && body.clientName.trim().length > 0
      ? body.clientName.trim()
      : undefined

  const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
  const redirectUri = body.electron
    ? `${protocol}://mcp-oauth-callback`
    : `${getAppBaseUrlFromRequest(c)}/api/remote-mcps/oauth-callback`

  if (body.mcpId) {
    // Existing server re-auth
    const userId = getCurrentUserId(c)
    const [server] = await db
      .select()
      .from(remoteMcpServers)
      .where(and(
        eq(remoteMcpServers.id, body.mcpId),
        isAuthMode() ? eq(remoteMcpServers.userId, userId) : undefined
      ))
      .limit(1)

    if (!server) {
      return c.json({ error: 'MCP server not found' }, 404)
    }

    const result = await initiateOAuthFlow(body.mcpId, server.url, redirectUri, clientNameOverride)

    if (!result) {
      const discoveryResult = await discoverOAuthMetadata(server.url)
      if (!discoveryResult) {
        return c.json({ error: 'This MCP server does not require OAuth authentication' }, 400)
      }
      return c.json({ error: 'Failed to initiate OAuth flow' }, 500)
    }

    return c.json({ redirectUrl: result.authorizationUrl, state: result.state })
  } else if (body.name && body.url) {
    // New server: OAuth-first flow (no DB insert yet)
    const result = await initiateNewServerOAuth(body.url.trim(), body.name.trim(), redirectUri, getCurrentUserId(c), clientNameOverride)

    if (!result) {
      const discoveryResult = await discoverOAuthMetadata(body.url.trim())
      if (!discoveryResult) {
        return c.json({ error: 'This MCP server does not require OAuth authentication' }, 400)
      }
      return c.json({ error: 'Failed to initiate OAuth flow' }, 500)
    }

    return c.json({ redirectUrl: result.authorizationUrl, state: result.state })
  } else {
    return c.json({ error: 'Either mcpId or name+url is required' }, 400)
  }
})

// OAuth callback handler (must be before /:id to avoid route shadowing)
remoteMcps.get('/oauth-callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    const safeError = escapeHtml(error)
    const errorPayload = JSON.stringify({ type: 'mcp-oauth-callback', success: false, error: safeError })
    return c.html(`
      <html><body><script>
        window.opener?.postMessage(${errorPayload}, '*');
        window.close();
      </script><p>OAuth error: ${safeError}. You can close this window.</p></body></html>
    `)
  }

  if (!code || !state) {
    return c.json({ error: 'Missing code or state parameter' }, 400)
  }

  const result = await completeOAuthFlow(state, code)

  if (!result.success || !result.mcpId) {
    const failPayload = JSON.stringify({ type: 'mcp-oauth-callback', success: false, error: 'Token exchange failed' })
    return c.html(`
      <html><body><script>
        window.opener?.postMessage(${failPayload}, '*');
        window.close();
      </script><p>OAuth failed. You can close this window.</p></body></html>
    `)
  }

  // Discover tools to verify the connection works
  let serverUrl: string | undefined
  try {
    const [server] = await db
      .select()
      .from(remoteMcpServers)
      .where(eq(remoteMcpServers.id, result.mcpId))
      .limit(1)

    if (server) {
      serverUrl = server.url
      const tools = await discoverTools(server.url, server.accessToken)
      await db
        .update(remoteMcpServers)
        .set({
          toolsJson: JSON.stringify(tools),
          toolsDiscoveredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(remoteMcpServers.id, result.mcpId))
    }
  } catch (err: any) {
    // Tool discovery failed — delete the server so we don't leave a broken entry
    await db.delete(remoteMcpServers).where(eq(remoteMcpServers.id, result.mcpId))
    const errorMsg = err.message || 'Tool discovery failed'
    const payload = JSON.stringify({ type: 'mcp-oauth-callback', success: false, error: `Connected but failed to discover tools: ${errorMsg}` })
    return c.html(`
      <html><body><script>
        window.opener?.postMessage(${payload}, '*');
        window.close();
      </script><p>OAuth succeeded but tool discovery failed. You can close this window.</p></body></html>
    `)
  }

  trackServerEvent('mcp_oauth_succeeded', { url: serverUrl, mcpId: result.mcpId })
  const successPayload = JSON.stringify({ type: 'mcp-oauth-callback', success: true, mcpId: result.mcpId })
  return c.html(`
    <html><body><script>
      window.opener?.postMessage(${successPayload}, '*');
      window.close();
    </script><p>OAuth successful! You can close this window.</p></body></html>
  `)
})

// Get a single MCP server
remoteMcps.get('/:id', Or(UsersMcpServer(), IsAdmin()), async (c) => {
  const id = c.req.param('id')
  const [server] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  if (!server) {
    return c.json({ error: 'MCP server not found' }, 404)
  }

  return c.json({
    server: sanitizeServer(server),
  })
})

// Update an MCP server
remoteMcps.patch('/:id', Or(UsersMcpServer(), IsAdmin()), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    url?: string
    authType?: 'none' | 'oauth' | 'bearer'
    accessToken?: string
    status?: 'active' | 'error' | 'auth_required'
  }>()

  const [existing] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  if (!existing) {
    return c.json({ error: 'MCP server not found' }, 404)
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.url !== undefined) updates.url = body.url.trim()
  if (body.authType !== undefined) updates.authType = body.authType
  if (body.accessToken !== undefined) updates.accessToken = body.accessToken
  if (body.status !== undefined) updates.status = body.status

  await db
    .update(remoteMcpServers)
    .set(updates)
    .where(eq(remoteMcpServers.id, id))

  const [updated] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  return c.json({
    server: sanitizeServer(updated),
  })
})

// Delete an MCP server
remoteMcps.delete('/:id', Or(UsersMcpServer(), IsAdmin()), async (c) => {
  const id = c.req.param('id')

  const [existing] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  if (!existing) {
    return c.json({ error: 'MCP server not found' }, 404)
  }

  await db.delete(remoteMcpServers).where(eq(remoteMcpServers.id, id))
  return c.json({ success: true })
})

// Discover tools from an MCP server
remoteMcps.post('/:id/discover-tools', Or(UsersMcpServer(), IsAdmin()), async (c) => {
  const id = c.req.param('id')

  const [server] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  if (!server) {
    return c.json({ error: 'MCP server not found' }, 404)
  }

  try {
    const tools = await discoverTools(server.url, server.accessToken)

    const now = new Date()
    await db
      .update(remoteMcpServers)
      .set({
        toolsJson: JSON.stringify(tools),
        toolsDiscoveredAt: now,
        status: 'active',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(remoteMcpServers.id, id))

    return c.json({ tools })
  } catch (error: any) {
    const errorMessage = error.message || 'Tool discovery failed'
    await db
      .update(remoteMcpServers)
      .set({
        status: 'error',
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(remoteMcpServers.id, id))

    return c.json({ error: errorMessage }, 502)
  }
})

// Test connection to an MCP server
remoteMcps.post('/:id/test-connection', Or(UsersMcpServer(), IsAdmin()), async (c) => {
  const id = c.req.param('id')

  const [server] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, id))
    .limit(1)

  if (!server) {
    return c.json({ error: 'MCP server not found' }, 404)
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }
    if (server.accessToken) {
      headers['Authorization'] = `Bearer ${server.accessToken}`
    }

    const res = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'Superagent', version: '1.0.0' },
        },
        id: 1,
      }),
    })

    if (res.status === 401) {
      await db
        .update(remoteMcpServers)
        .set({ status: 'auth_required', errorMessage: 'Authentication required', updatedAt: new Date() })
        .where(eq(remoteMcpServers.id, id))
      return c.json({ success: false, error: 'Authentication required', needsAuth: true })
    }

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`)
    }

    await db
      .update(remoteMcpServers)
      .set({ status: 'active', errorMessage: null, updatedAt: new Date() })
      .where(eq(remoteMcpServers.id, id))

    return c.json({ success: true })
  } catch (error: any) {
    const errorMessage = error.message || 'Connection test failed'
    await db
      .update(remoteMcpServers)
      .set({ status: 'error', errorMessage, updatedAt: new Date() })
      .where(eq(remoteMcpServers.id, id))
    return c.json({ success: false, error: errorMessage })
  }
})

export default remoteMcps
