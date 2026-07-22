import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { remoteMcpServers } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { mcpSafeFetch } from '@shared/lib/mcp/mcp-safe-fetch'
import { validateMcpDiscoveryUrl } from '@shared/lib/utils/url-safety'
import type { OAuthMetadata, OAuthTokenResponse } from './types'

/**
 * OAuth setup failure whose message is safe to show in the UI verbatim. Carries
 * the authorization server's own error/error_description (e.g. a dynamic client
 * registration rejection reason) so users see why a connection failed instead
 * of a generic "Failed to initiate OAuth flow".
 */
export class McpOAuthSetupError extends Error {}

/**
 * Summarize an OAuth error response body for a user-facing message: prefer the
 * RFC 6749 error/error_description fields, fall back to the raw (truncated)
 * body — some servers reject with a bare-text body (e.g. Figma's "Forbidden").
 */
async function describeOAuthErrorBody(res: Response): Promise<string> {
  let text: string
  try {
    text = (await res.text()).trim()
  } catch {
    return ''
  }
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown }
    const detail = [parsed.error, parsed.error_description]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(': ')
    if (detail) return `: ${detail}`
  } catch {
    // Not JSON — fall through to the raw body
  }
  return `: ${text.slice(0, 200)}`
}

/**
 * Build the candidate well-known metadata URLs for an authorization server.
 *
 * For issuers with a path, RFC 8414 inserts /.well-known/<name> between origin
 * and path; OpenID Connect appends to the issuer. We try both, in the order
 * most likely to succeed for MCP servers.
 */
export function buildAuthServerMetadataUrls(authServerUrl: string): string[] {
  let parsed: URL
  try {
    parsed = new URL(authServerUrl)
  } catch {
    return []
  }
  const origin = parsed.origin
  const path = parsed.pathname.replace(/\/+$/, '')
  const appendBase = `${origin}${path}`

  if (path === '' || path === '/') {
    return [
      `${origin}/.well-known/oauth-authorization-server`,
      `${origin}/.well-known/openid-configuration`,
    ]
  }
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${appendBase}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${appendBase}/.well-known/openid-configuration`,
  ]
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  return { codeVerifier, codeChallenge }
}

/**
 * Discover OAuth metadata from an MCP server.
 *
 * Flow:
 * 1. Make unauthenticated request to MCP URL -> get 401 with WWW-Authenticate header
 * 2. Extract resource_metadata URL from WWW-Authenticate
 * 3. Fetch Protected Resource Metadata (RFC 9728)
 * 4. Fetch Authorization Server Metadata (RFC 8414 / OpenID Connect Discovery)
 */
export async function discoverOAuthMetadata(mcpUrl: string): Promise<{
  metadata: OAuthMetadata
  resource: string
  scopesSupported?: string[]
  challengeScope?: string
} | null> {
  try {
    // Step 1: Make unauthenticated request to get 401
    const probeResponse = await mcpSafeFetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    })

    if (probeResponse.status !== 401) {
      // Server doesn't require auth
      return null
    }

    // Step 2: Extract resource_metadata (and any scope challenge) from
    // WWW-Authenticate. RFC 6750 §3 lets the resource server name the scopes
    // required for access; the MCP auth spec makes this the top-priority source
    // for the scope the client requests, ahead of scopes_supported.
    const wwwAuth = probeResponse.headers.get('WWW-Authenticate') || ''
    const resourceMetadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/)
    const challengeScopeMatch = wwwAuth.match(/scope="([^"]+)"/)
    const challengeScope = challengeScopeMatch ? challengeScopeMatch[1] : undefined

    let authServerUrl: string
    let resource: string
    // Scopes advertised by the Protected Resource Metadata (RFC 9728). Per the
    // MCP auth spec's scope-selection strategy, when the 401 WWW-Authenticate
    // carries no `scope`, the client requests all of the resource's
    // scopes_supported. Captured here so the caller can put it on the auth URL.
    let resourceScopes: string[] | undefined

    if (resourceMetadataMatch) {
      // RFC 9728: Fetch Protected Resource Metadata.
      // SSRF: server-controlled WWW-Authenticate URL — mcpSafeFetch rejects
      // private/loopback (incl. DNS-rebind) before connecting.
      const resourceMetadataUrl = resourceMetadataMatch[1]
      const resourceRes = await mcpSafeFetch(resourceMetadataUrl)
      if (!resourceRes.ok) {
        throw new Error(`Failed to fetch resource metadata: ${resourceRes.status}`)
      }
      const resourceMetadata = (await resourceRes.json()) as {
        resource?: string
        authorization_servers?: string[]
        scopes_supported?: string[]
      }
      resource = resourceMetadata.resource || new URL(mcpUrl).origin
      resourceScopes = resourceMetadata.scopes_supported
      const authServers = resourceMetadata.authorization_servers || []
      if (authServers.length === 0) {
        throw new Error('No authorization servers found in resource metadata')
      }
      authServerUrl = authServers[0]
    } else {
      // Fallback: try .well-known on the MCP server's origin
      const origin = new URL(mcpUrl).origin
      resource = origin
      authServerUrl = origin
    }

    // Step 3: Fetch Authorization Server Metadata.
    // RFC 8414 §3.1 specifies that when the issuer URL has a path component,
    // the well-known segment is inserted between origin and path (e.g.
    // https://host/.well-known/oauth-authorization-server/path), not appended.
    // Some servers (e.g. Meta's MCP) only expose the path-aware form.
    // OpenID Connect Discovery 1.0 instead appends to the issuer.
    // SSRF guard (SUP-235): authServerUrl is server-supplied (either from the
    // protected-resource metadata's authorization_servers[0] or the MCP
    // origin). Reject private/loopback auth servers before deriving and
    // fetching any well-known URLs from them; throwing fails discovery closed.
    await validateMcpDiscoveryUrl(authServerUrl)

    const wellKnownUrls = buildAuthServerMetadataUrls(authServerUrl)

    for (const url of wellKnownUrls) {
      try {
        // mcpSafeFetch rejects private/loopback; catch skips to the next candidate.
        const res = await mcpSafeFetch(url)
        if (res.ok) {
          const metadata = (await res.json()) as OAuthMetadata
          if (metadata.authorization_endpoint && metadata.token_endpoint) {
            // Prefer the resource's advertised scopes; fall back to the
            // authorization server's scopes_supported.
            return {
              metadata,
              resource,
              scopesSupported: resourceScopes ?? metadata.scopes_supported,
              challengeScope,
            }
          }
        }
      } catch {
        continue
      }
    }

    throw new Error('Could not discover OAuth metadata from authorization server')
  } catch (error) {
    console.error('[mcp/oauth] Discovery failed:', error)
    return null
  }
}

/**
 * Register a dynamic client with the authorization server (RFC 7591).
 * Throws McpOAuthSetupError with the server's rejection reason on failure.
 */
export async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId: string; clientSecret?: string; scope?: string }> {
  let res: Response
  try {
    res = await mcpSafeFetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
  } catch (error) {
    throw new McpOAuthSetupError(
      `Could not reach the authorization server's registration endpoint: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!res.ok) {
    throw new McpOAuthSetupError(
      `The authorization server rejected client registration (HTTP ${res.status})${await describeOAuthErrorBody(res)}`,
    )
  }

  let data: { client_id: string; client_secret?: string; scope?: string }
  try {
    data = await res.json()
  } catch {
    throw new McpOAuthSetupError(
      'The authorization server returned an invalid client registration response',
    )
  }
  return { clientId: data.client_id, clientSecret: data.client_secret, scope: data.scope }
}

/**
 * Register a dynamic client, trying each candidate redirect URI in order until
 * one is accepted. Returns the winning redirect URI alongside the credentials.
 *
 * Strict authorization servers (e.g. cal.com) reject any non-http(s) redirect
 * during registration ("only http and https are allowed"), so the caller passes
 * the custom app scheme first and an http loopback URL as the fallback. Whatever
 * the AS accepts is what we must then use on the authorization and token
 * requests — so it is returned here rather than assumed by the caller.
 */
async function registerDynamicClientWithFallback(
  registrationEndpoint: string,
  redirectCandidates: string[],
  clientName: string,
): Promise<{ clientId: string; clientSecret?: string; scope?: string; redirectUri: string }> {
  let lastError: McpOAuthSetupError | undefined
  for (const redirectUri of redirectCandidates) {
    try {
      const registration = await registerDynamicClient(registrationEndpoint, redirectUri, clientName)
      return { ...registration, redirectUri }
    } catch (error) {
      if (!(error instanceof McpOAuthSetupError)) throw error
      console.error(`[mcp/oauth] Dynamic registration failed for redirect ${redirectUri}:`, error.message)
      lastError = error
    }
  }
  throw lastError ?? new McpOAuthSetupError('No redirect URLs available for client registration')
}

type PendingOAuthFlow = {
  codeVerifier: string
  redirectUri: string
  resource: string
  tokenEndpoint: string
  expectedIssuer?: string
  authorizationResponseIssParameterSupported: boolean
  clientId: string
  clientSecret?: string
  mcpId?: string
  newServer?: { name: string; url: string }
  userId?: string
  // True when the flow was initiated by the Electron app. Combined with whether
  // the winning redirect is the custom app scheme, this tells the callback route
  // how to hand the result back (see completeOAuthFlow's return).
  electron?: boolean
}

type OAuthIssuerValidationResult =
  | { valid: true }
  | { valid: false; error: string }

// In-memory store for pending OAuth flows
const pendingOAuthFlows = new Map<string, PendingOAuthFlow>()

/**
 * How the callback route should deliver the result to the client, derived from
 * the pending flow. `redirectWasScheme` is true for the custom app scheme (any
 * non-http(s) redirect) — that path is fetched+parsed by the Electron main
 * process — and false for an http loopback redirect loaded in the external
 * browser, which must be handed back to the app.
 */
function flowDeliveryFlags(flow: PendingOAuthFlow): {
  electron: boolean
  redirectWasScheme: boolean
} {
  return {
    electron: flow.electron === true,
    redirectWasScheme: !/^https?:/i.test(flow.redirectUri),
  }
}

function validateAuthorizationResponseIssuer(
  flow: PendingOAuthFlow,
  iss: string | null | undefined,
): OAuthIssuerValidationResult {
  const hasIss = iss !== undefined && iss !== null

  if (flow.authorizationResponseIssParameterSupported && !hasIss) {
    return {
      valid: false,
      error: 'Missing OAuth issuer parameter',
    }
  }

  if (!hasIss) {
    return { valid: true }
  }

  if (!flow.expectedIssuer) {
    return {
      valid: false,
      error: 'Missing expected OAuth issuer',
    }
  }

  if (iss !== flow.expectedIssuer) {
    return {
      valid: false,
      error: 'OAuth issuer mismatch',
    }
  }

  return { valid: true }
}

export function validateAndConsumeOAuthErrorResponse(
  state: string | null | undefined,
  iss: string | null | undefined,
): OAuthIssuerValidationResult & { electron?: boolean; redirectWasScheme?: boolean } {
  if (!state) {
    return {
      valid: false,
      error: 'Missing OAuth state parameter',
    }
  }

  const flow = pendingOAuthFlows.get(state)
  if (!flow) {
    return {
      valid: false,
      error: 'No pending OAuth flow for state',
    }
  }

  const delivery = flowDeliveryFlags(flow)

  const validation = validateAuthorizationResponseIssuer(flow, iss)
  if (!validation.valid) {
    console.error('[mcp/oauth] Authorization error issuer validation failed:', validation.error)
    return { ...validation, ...delivery }
  }

  pendingOAuthFlows.delete(state)
  return { valid: true, ...delivery }
}

/**
 * Initiate an OAuth flow for a remote MCP server.
 * Returns the authorization URL to redirect the user to.
 */
export async function initiateOAuthFlow(
  mcpId: string,
  mcpUrl: string,
  redirectCandidates: string[],
  electron = false,
  clientNameOverride?: string,
  clientIdOverride?: string,
  clientSecretOverride?: string,
): Promise<{
  authorizationUrl: string
  state: string
} | null> {
  // Discover OAuth endpoints
  const discovery = await discoverOAuthMetadata(mcpUrl)
  if (!discovery) return null

  const { metadata, resource, scopesSupported, challengeScope } = discovery

  // Verify S256 is supported
  const supportedMethods = metadata.code_challenge_methods_supported || []
  if (supportedMethods.length > 0 && !supportedMethods.includes('S256')) {
    console.error('[mcp/oauth] Server does not support S256 PKCE')
    throw new McpOAuthSetupError(
      `The authorization server does not support the required S256 PKCE method (supports: ${supportedMethods.join(', ')})`,
    )
  }

  // Resolve client credentials: explicit override > dynamic registration > stored.
  let clientId: string | undefined
  let clientSecret: string | undefined
  let registeredScope: string | undefined
  // Redirect actually used on the authorization + token requests. Defaults to the
  // preferred candidate; dynamic registration may switch it to a fallback the AS
  // accepts (e.g. an http loopback URL when the custom app scheme is rejected).
  let redirectUri = redirectCandidates[0]

  // Check if we already have client credentials stored
  const [existing] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, mcpId))
    .limit(1)

  if (clientIdOverride) {
    clientId = clientIdOverride
    clientSecret = clientSecretOverride || undefined
  } else if (metadata.registration_endpoint) {
    // Prefer a fresh dynamic registration over a stored client_id on re-auth: it
    // self-heals which redirect the AS accepts (custom scheme vs http loopback)
    // and re-binds to the current loopback port, so a client first registered
    // against a rejected scheme or a stale port doesn't break reconnection.
    try {
      const registration = await registerDynamicClientWithFallback(
        metadata.registration_endpoint,
        redirectCandidates,
        clientNameOverride && clientNameOverride.length > 0 ? clientNameOverride : 'Gamut',
      )
      clientId = registration.clientId
      clientSecret = registration.clientSecret
      registeredScope = registration.scope
      redirectUri = registration.redirectUri
    } catch (error) {
      if (!(error instanceof McpOAuthSetupError)) throw error
      if (existing?.oauthClientId) {
        // Registration failed unexpectedly — fall back to the stored client.
        clientId = existing.oauthClientId
        clientSecret = existing.oauthClientSecret || undefined
      } else {
        throw error
      }
    }
  } else if (existing?.oauthClientId) {
    clientId = existing.oauthClientId
    clientSecret = existing.oauthClientSecret || undefined
  }

  if (!clientId) {
    console.error('[mcp/oauth] No client_id available')
    throw new McpOAuthSetupError(
      'The authorization server does not support automatic client registration — provide an OAuth Client ID in the advanced connection options',
    )
  }

  // Generate PKCE and state
  const { codeVerifier, codeChallenge } = generatePKCE()
  const state = crypto.randomBytes(16).toString('hex')

  // Store OAuth metadata in the MCP server record
  await db
    .update(remoteMcpServers)
    .set({
      oauthTokenEndpoint: metadata.token_endpoint,
      oauthClientId: clientId,
      oauthClientSecret: clientSecret || null,
      oauthResource: resource,
      updatedAt: new Date(),
    })
    .where(eq(remoteMcpServers.id, mcpId))

  // Store flow state for callback
  pendingOAuthFlows.set(state, {
    codeVerifier,
    redirectUri,
    resource,
    tokenEndpoint: metadata.token_endpoint,
    expectedIssuer: metadata.issuer,
    authorizationResponseIssParameterSupported:
      metadata.authorization_response_iss_parameter_supported === true,
    clientId,
    clientSecret,
    mcpId,
    electron,
  })

  // Build authorization URL
  let authUrl: URL
  try {
    authUrl = new URL(metadata.authorization_endpoint)
  } catch {
    throw new Error(`Invalid authorization endpoint URL: ${metadata.authorization_endpoint}`)
  }
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  // RFC 8707: bind the token's audience to this MCP resource. Required by the
  // MCP auth spec on both the authorization AND token requests — omitting it
  // here lets the AS issue a token with the wrong audience, which the resource
  // server then rejects on initialize (401).
  authUrl.searchParams.set('resource', resource)
  // Scope selection follows the MCP auth spec's priority order:
  //   1. the scope challenged in the 401 WWW-Authenticate header (RFC 6750 §3)
  //   2. the scope granted at dynamic client registration
  //   3. all scopes the resource/AS advertise in scopes_supported
  // Servers like Robinhood challenge no scope and their DCR echoes none, so we
  // fall to (3) and send scopes_supported (["internal"]); without any scope the
  // AS ignores the request and bounces the user back with no consent screen.
  const scope = challengeScope || registeredScope || scopesSupported?.join(' ')
  if (scope) {
    authUrl.searchParams.set('scope', scope)
  }

  return {
    authorizationUrl: authUrl.toString(),
    state,
  }
}

/**
 * Initiate an OAuth flow for a new MCP server (not yet in DB).
 * The server record is created only after tokens are obtained.
 */
export async function initiateNewServerOAuth(
  mcpUrl: string,
  name: string,
  redirectCandidates: string[],
  electron = false,
  userId?: string,
  clientNameOverride?: string,
  clientIdOverride?: string,
  clientSecretOverride?: string,
): Promise<{
  authorizationUrl: string
  state: string
} | null> {
  const discovery = await discoverOAuthMetadata(mcpUrl)
  if (!discovery) return null

  const { metadata, resource, scopesSupported, challengeScope } = discovery

  const supportedMethods = metadata.code_challenge_methods_supported || []
  if (supportedMethods.length > 0 && !supportedMethods.includes('S256')) {
    console.error('[mcp/oauth] Server does not support S256 PKCE')
    throw new McpOAuthSetupError(
      `The authorization server does not support the required S256 PKCE method (supports: ${supportedMethods.join(', ')})`,
    )
  }

  let clientId: string | undefined
  let clientSecret: string | undefined
  let registeredScope: string | undefined
  // Redirect actually used on the authorization + token requests. Defaults to the
  // preferred candidate; dynamic registration may switch it to a fallback the AS
  // accepts (e.g. an http loopback URL when the custom app scheme is rejected).
  let redirectUri = redirectCandidates[0]

  if (clientIdOverride) {
    clientId = clientIdOverride
    clientSecret = clientSecretOverride || undefined
  } else if (metadata.registration_endpoint) {
    const registration = await registerDynamicClientWithFallback(
      metadata.registration_endpoint,
      redirectCandidates,
      clientNameOverride && clientNameOverride.length > 0 ? clientNameOverride : 'Gamut',
    )
    clientId = registration.clientId
    clientSecret = registration.clientSecret
    registeredScope = registration.scope
    redirectUri = registration.redirectUri
  }

  if (!clientId) {
    console.error('[mcp/oauth] No client_id available — provide an OAuth Client ID or use a server that supports dynamic registration')
    throw new McpOAuthSetupError(
      'The authorization server does not support automatic client registration — provide an OAuth Client ID in the advanced connection options',
    )
  }

  const { codeVerifier, codeChallenge } = generatePKCE()
  const state = crypto.randomBytes(16).toString('hex')

  pendingOAuthFlows.set(state, {
    codeVerifier,
    redirectUri,
    resource,
    tokenEndpoint: metadata.token_endpoint,
    expectedIssuer: metadata.issuer,
    authorizationResponseIssParameterSupported:
      metadata.authorization_response_iss_parameter_supported === true,
    clientId,
    clientSecret,
    newServer: { name, url: mcpUrl },
    userId,
    electron,
  })

  let authUrl: URL
  try {
    authUrl = new URL(metadata.authorization_endpoint)
  } catch {
    throw new Error(`Invalid authorization endpoint URL: ${metadata.authorization_endpoint}`)
  }
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  // RFC 8707: bind the token's audience to this MCP resource. Required by the
  // MCP auth spec on both the authorization AND token requests — omitting it
  // here lets the AS issue a token with the wrong audience, which the resource
  // server then rejects on initialize (401).
  authUrl.searchParams.set('resource', resource)
  // Scope selection follows the MCP auth spec's priority order:
  //   1. the scope challenged in the 401 WWW-Authenticate header (RFC 6750 §3)
  //   2. the scope granted at dynamic client registration
  //   3. all scopes the resource/AS advertise in scopes_supported
  // Servers like Robinhood challenge no scope and their DCR echoes none, so we
  // fall to (3) and send scopes_supported (["internal"]); without any scope the
  // AS ignores the request and bounces the user back with no consent screen.
  const scope = challengeScope || registeredScope || scopesSupported?.join(' ')
  if (scope) {
    authUrl.searchParams.set('scope', scope)
  }

  return { authorizationUrl: authUrl.toString(), state }
}

/**
 * Complete an OAuth flow by exchanging the authorization code for tokens.
 * Handles both new server creation and existing server re-auth.
 */
export async function completeOAuthFlow(
  state: string,
  code: string,
  iss?: string | null,
): Promise<{ success: boolean; mcpId?: string; electron?: boolean; redirectWasScheme?: boolean }> {
  const flow = pendingOAuthFlows.get(state)
  if (!flow) {
    console.error('[mcp/oauth] No pending flow for state:', state)
    return { success: false }
  }

  // How the callback route should hand the result back: the custom app scheme
  // path is fetched+parsed by the Electron main process (parseable HTML), while
  // the http loopback path is loaded in the external browser (needs a hand-off
  // back to the app).
  const { electron, redirectWasScheme } = flowDeliveryFlags(flow)

  const issuerValidation = validateAuthorizationResponseIssuer(flow, iss)
  if (!issuerValidation.valid) {
    console.error('[mcp/oauth] Authorization response issuer validation failed:', issuerValidation.error)
    return { success: false, electron, redirectWasScheme }
  }

  pendingOAuthFlows.delete(state)

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.codeVerifier,
      resource: flow.resource,
    })
    if (flow.clientSecret) {
      body.set('client_secret', flow.clientSecret)
    }

    const res = await mcpSafeFetch(flow.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) {
      const errorBody = await res.text()
      console.error('[mcp/oauth] Token exchange failed:', res.status, errorBody)
      return { success: false, electron, redirectWasScheme }
    }

    const tokens: OAuthTokenResponse = await res.json()
    const now = new Date()
    const expiresAt = tokens.expires_in
      ? new Date(now.getTime() + tokens.expires_in * 1000)
      : null

    if (flow.newServer) {
      // New server: INSERT with tokens
      const id = crypto.randomUUID()
      await db.insert(remoteMcpServers).values({
        id,
        name: flow.newServer.name,
        url: flow.newServer.url,
        userId: flow.userId,
        authType: 'oauth',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenExpiresAt: expiresAt,
        oauthTokenEndpoint: flow.tokenEndpoint,
        oauthClientId: flow.clientId,
        oauthClientSecret: flow.clientSecret || null,
        oauthResource: flow.resource,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      return { success: true, mcpId: id, electron, redirectWasScheme }
    } else if (flow.mcpId) {
      // Existing server: UPDATE with tokens
      await db
        .update(remoteMcpServers)
        .set({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || null,
          tokenExpiresAt: expiresAt,
          status: 'active',
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(remoteMcpServers.id, flow.mcpId))
      return { success: true, mcpId: flow.mcpId, electron, redirectWasScheme }
    }

    return { success: false, electron, redirectWasScheme }
  } catch (error) {
    console.error('[mcp/oauth] Token exchange error:', error)
    return { success: false, electron, redirectWasScheme }
  }
}

/**
 * Refresh an expired OAuth token for an MCP server.
 */
export async function refreshMcpToken(mcpId: string): Promise<string | null> {
  const [mcp] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, mcpId))
    .limit(1)

  if (!mcp || !mcp.refreshToken || !mcp.oauthTokenEndpoint || !mcp.oauthClientId) {
    return null
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: mcp.refreshToken,
      client_id: mcp.oauthClientId,
    })
    if (mcp.oauthClientSecret) {
      body.set('client_secret', mcp.oauthClientSecret)
    }
    if (mcp.oauthResource) {
      body.set('resource', mcp.oauthResource)
    }

    const res = await mcpSafeFetch(mcp.oauthTokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) return null

    const tokens: OAuthTokenResponse = await res.json()
    const now = new Date()
    const expiresAt = tokens.expires_in
      ? new Date(now.getTime() + tokens.expires_in * 1000)
      : null

    await db
      .update(remoteMcpServers)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || mcp.refreshToken,
        tokenExpiresAt: expiresAt,
        status: 'active',
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(remoteMcpServers.id, mcpId))

    return tokens.access_token
  } catch {
    return null
  }
}
