import { Hono } from 'hono'
import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { remoteMcpServers, agentRemoteMcps } from '@shared/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import {
  initiateOAuthFlow,
  initiateNewServerOAuth,
  completeOAuthFlow,
  validateAndConsumeOAuthErrorResponse,
  discoverOAuthMetadata,
  McpOAuthSetupError,
} from '@shared/lib/mcp/oauth'
import type { McpToolInfo } from '@shared/lib/mcp/types'
import { getAppBaseUrlFromRequest, getCurrentUserId } from '@shared/lib/auth/config'
import { isAuthMode } from '@shared/lib/auth/mode'
import { Authenticated, UsersMcpServer, IsAdmin, Or } from '../middleware/auth'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import { mcpSafeFetch, validateMcpDiscoveryUrl } from '@shared/lib/utils/url-safety'
import { discoverTools } from '@shared/lib/mcp/discover-tools'

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

type McpOAuthCallbackPayload = {
  type: 'mcp-oauth-callback'
  success: boolean
  mcpId?: string
  error?: string
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function renderMcpOAuthCallbackHtml(payload: McpOAuthCallbackPayload, message: string): string {
  const safeMessage = escapeHtml(message)
  const payloadJson = safeScriptJson(payload)
  const storageValueJson = safeScriptJson(JSON.stringify({
    ...payload,
    deliveredAt: Date.now(),
  }))

  return `
    <html><body><script>
      const payload = ${payloadJson};
      window.opener?.postMessage(payload, window.location.origin);
      try {
        const channel = new BroadcastChannel('mcp-oauth-callback');
        channel.postMessage(payload);
        channel.close();
      } catch {}
      try {
        localStorage.setItem('superagent.mcp-oauth-callback', ${storageValueJson});
        localStorage.removeItem('superagent.mcp-oauth-callback');
      } catch {}
      setTimeout(() => window.close(), 0);
    </script><p>${safeMessage}</p></body></html>
  `
}

/**
 * Callback page for the Electron http-loopback OAuth path. Unlike the custom
 * scheme path (where the Electron main process fetches this route directly), this
 * page is loaded in the user's external browser after the token exchange has
 * already completed server-side. It hands the result back into the app via the
 * custom scheme so the main process can notify the renderer over IPC.
 */
function renderMcpOAuthHandoffHtml(payload: McpOAuthCallbackPayload): string {
  const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
  const params = new URLSearchParams()
  params.set('success', payload.success ? 'true' : 'false')
  if (payload.mcpId) params.set('mcpId', payload.mcpId)
  if (payload.error) params.set('error', payload.error)
  const deepLink = `${protocol}://mcp-oauth-callback?${params.toString()}`

  const message = payload.success
    ? 'Authentication successful! Returning to the app…'
    : `Authentication failed${payload.error ? `: ${payload.error}` : ''}. Returning to the app…`

  return `
    <html><body><script>
      window.location.replace(${safeScriptJson(deepLink)});
    </script>
    <p>${escapeHtml(message)}</p>
    <p><a href="${escapeHtml(deepLink)}">Click here if you are not returned automatically.</a></p>
    </body></html>
  `
}

/**
 * Pick the right callback response. The Electron http-loopback path (loaded in
 * the external browser) hands back via the custom scheme; every other case (web,
 * or the Electron custom-scheme path fetched by the main process) uses the
 * postMessage/BroadcastChannel/localStorage bridge.
 */
function mcpOAuthCallbackBody(
  payload: McpOAuthCallbackPayload,
  message: string,
  delivery: { electron?: boolean; redirectWasScheme?: boolean },
): string {
  if (delivery.electron && delivery.redirectWasScheme === false) {
    return renderMcpOAuthHandoffHtml(payload)
  }
  return renderMcpOAuthCallbackHtml(payload, message)
}

// Entry-path SSRF guard for the user-supplied MCP server URL. Delegates to the
// shared policy so it cannot drift from the OAuth-discovery checks, which must
// reject the same private/loopback hosts on every server-supplied metadata URL.
async function validateMcpServerUrl(url: string): Promise<URL> {
  return validateMcpDiscoveryUrl(url)
}

const remoteMcps = new Hono()

remoteMcps.use('*', Authenticated())

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

  try {
    await validateMcpServerUrl(body.url.trim())
  } catch (e: any) {
    return c.json({ error: e.message }, 400)
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
    // 401 means either auth is needed or the supplied token was rejected.
    if (error.message?.includes('401')) {
      const discovery = await discoverOAuthMetadata(body.url.trim())
      if (body.accessToken) {
        if (discovery) {
          return c.json({
            error: 'The bearer token was rejected by this MCP server (401). This server supports OAuth — connect via OAuth instead.',
            needsOAuth: true,
            tokenRejected: true,
          }, 401)
        }
        return c.json({
          error: 'The bearer token was rejected by this MCP server (401). Verify it is valid and has access to this server.',
          tokenRejected: true,
        }, 401)
      }
      if (discovery) {
        return c.json({ error: 'This MCP server requires OAuth authentication', needsOAuth: true }, 400)
      }
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

  logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: id, action: 'created', details: { name: body.name.trim(), url: body.url.trim() } })

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
    clientId?: string
    clientSecret?: string
  }>()

  const clientNameOverride =
    typeof body.clientName === 'string' && body.clientName.trim().length > 0
      ? body.clientName.trim()
      : undefined
  const clientIdOverride =
    typeof body.clientId === 'string' && body.clientId.trim().length > 0
      ? body.clientId.trim()
      : undefined
  const clientSecretOverride =
    typeof body.clientSecret === 'string' && body.clientSecret.trim().length > 0
      ? body.clientSecret.trim()
      : undefined

  // Ordered redirect candidates. In Electron we prefer the custom app scheme
  // (port-independent, no external-browser hand-off needed) but fall back to an
  // http loopback URL for authorization servers that reject non-http(s) redirects
  // during dynamic client registration (e.g. cal.com). Web only has the http URL.
  //
  // The loopback base must come from the request URL's origin (http://localhost:<apiPort>),
  // not getAppBaseUrlFromRequest: the packaged renderer is served from file://, so its
  // fetches carry `Origin: null`. The AS redirects the external browser here to complete
  // the flow, so the URL must be one the local API server actually answers on.
  const protocol = process.env.SUPERAGENT_PROTOCOL || 'superagent'
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- c.req.url is always a valid URL
  const loopbackRedirect = `${new URL(c.req.url).origin}/api/remote-mcps/oauth-callback`
  const httpRedirect = body.electron
    ? loopbackRedirect
    : `${getAppBaseUrlFromRequest(c)}/api/remote-mcps/oauth-callback`
  const redirectCandidates = body.electron
    ? [`${protocol}://mcp-oauth-callback`, httpRedirect]
    : [httpRedirect]

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

    let result
    try {
      result = await initiateOAuthFlow(body.mcpId, server.url, redirectCandidates, !!body.electron, clientNameOverride, clientIdOverride, clientSecretOverride)
    } catch (e) {
      if (e instanceof McpOAuthSetupError) return c.json({ error: e.message }, 500)
      throw e
    }

    if (!result) {
      const discoveryResult = await discoverOAuthMetadata(server.url)
      if (!discoveryResult) {
        return c.json({ error: 'This MCP server does not require OAuth authentication' }, 400)
      }
      return c.json({ error: 'Failed to initiate OAuth flow' }, 500)
    }

    return c.json({ redirectUrl: result.authorizationUrl, state: result.state })
  } else if (body.name && body.url) {
    try {
      await validateMcpServerUrl(body.url.trim())
    } catch (e: any) {
      return c.json({ error: e.message }, 400)
    }

    // New server: OAuth-first flow (no DB insert yet)
    let result
    try {
      result = await initiateNewServerOAuth(body.url.trim(), body.name.trim(), redirectCandidates, !!body.electron, getCurrentUserId(c), clientNameOverride, clientIdOverride, clientSecretOverride)
    } catch (e) {
      if (e instanceof McpOAuthSetupError) return c.json({ error: e.message }, 500)
      throw e
    }

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
  const iss = c.req.query('iss')

  if (error) {
    const issuerValidation = validateAndConsumeOAuthErrorResponse(state, iss)
    if (!issuerValidation.valid) {
      return c.html(mcpOAuthCallbackBody(
        { type: 'mcp-oauth-callback', success: false, error: 'OAuth callback validation failed' },
        'OAuth callback validation failed. You can close this window.',
        issuerValidation,
      ))
    }

    return c.html(mcpOAuthCallbackBody(
      { type: 'mcp-oauth-callback', success: false, error },
      `OAuth error: ${error}. You can close this window.`,
      issuerValidation,
    ))
  }

  if (!code || !state) {
    return c.json({ error: 'Missing code or state parameter' }, 400)
  }

  const result = await completeOAuthFlow(state, code, iss)
  const delivery = { electron: result.electron, redirectWasScheme: result.redirectWasScheme }

  if (!result.success || !result.mcpId) {
    return c.html(mcpOAuthCallbackBody(
      { type: 'mcp-oauth-callback', success: false, error: 'Token exchange failed' },
      'OAuth failed. You can close this window.',
      delivery,
    ))
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
    return c.html(mcpOAuthCallbackBody(
      {
        type: 'mcp-oauth-callback',
        success: false,
        error: `Connected but failed to discover tools: ${errorMsg}`,
      },
      'OAuth succeeded but tool discovery failed. You can close this window.',
      delivery,
    ))
  }

  trackServerEvent('mcp_oauth_succeeded', { url: serverUrl, mcpId: result.mcpId })
  return c.html(mcpOAuthCallbackBody(
    { type: 'mcp-oauth-callback', success: true, mcpId: result.mcpId },
    'OAuth successful! You can close this window.',
    delivery,
  ))
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

// List agent slugs that have this MCP server mapped
remoteMcps.get('/:id/agents', Or(UsersMcpServer(), IsAdmin()), async (c) => {
  try {
    const id = c.req.param('id')
    const mappings = await db
      .select({ agentSlug: agentRemoteMcps.agentSlug })
      .from(agentRemoteMcps)
      .where(eq(agentRemoteMcps.remoteMcpId, id))
    return c.json({ agentSlugs: mappings.map((m) => m.agentSlug) })
  } catch (error) {
    console.error('Failed to list agents for MCP server:', error)
    return c.json({ error: 'Failed to list agents' }, 500)
  }
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

  if (body.url !== undefined) {
    try {
      await validateMcpServerUrl(body.url.trim())
    } catch (e: any) {
      return c.json({ error: e.message }, 400)
    }
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

  logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: id, action: 'updated' })

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

  logAuditEvent({ userId: getCurrentUserId(c), object: 'mcp', objectId: id, action: 'deleted', details: { name: existing.name } })

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
    await validateMcpServerUrl(server.url)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }
    if (server.accessToken) {
      headers['Authorization'] = `Bearer ${server.accessToken}`
    }

    const res = await mcpSafeFetch(server.url, {
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
