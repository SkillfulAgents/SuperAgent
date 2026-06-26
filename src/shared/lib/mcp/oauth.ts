import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { remoteMcpServers } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { validateMcpDiscoveryUrl } from '@shared/lib/utils/url-safety'
import type { OAuthMetadata, OAuthTokenResponse } from './types'

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
    const probeResponse = await fetch(mcpUrl, {
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
      // SSRF guard (SUP-235): this URL comes straight from the server-controlled
      // WWW-Authenticate header, so apply the same private/loopback host policy
      // as the entry path before fetching. Rejection throws -> discovery fails
      // closed (returns null) instead of fetching an internal address.
      const resourceMetadataUrl = resourceMetadataMatch[1]
      validateMcpDiscoveryUrl(resourceMetadataUrl)
      const resourceRes = await fetch(resourceMetadataUrl)
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
    validateMcpDiscoveryUrl(authServerUrl)

    const wellKnownUrls = buildAuthServerMetadataUrls(authServerUrl)

    for (const url of wellKnownUrls) {
      try {
        // Defense in depth: re-validate each generated URL so a future change
        // to buildAuthServerMetadataUrls can never reintroduce an unchecked
        // fetch. A rejected URL is skipped, not fetched.
        validateMcpDiscoveryUrl(url)
        const res = await fetch(url)
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
 */
export async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId: string; clientSecret?: string; scope?: string } | null> {
  try {
    const res = await fetch(registrationEndpoint, {
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

    if (!res.ok) return null

    const data = (await res.json()) as {
      client_id: string
      client_secret?: string
      scope?: string
    }
    return { clientId: data.client_id, clientSecret: data.client_secret, scope: data.scope }
  } catch {
    return null
  }
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
}

type OAuthIssuerValidationResult =
  | { valid: true }
  | { valid: false; error: string }

// In-memory store for pending OAuth flows
const pendingOAuthFlows = new Map<string, PendingOAuthFlow>()

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
): OAuthIssuerValidationResult {
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

  const validation = validateAuthorizationResponseIssuer(flow, iss)
  if (!validation.valid) {
    console.error('[mcp/oauth] Authorization error issuer validation failed:', validation.error)
    return validation
  }

  pendingOAuthFlows.delete(state)
  return { valid: true }
}

/**
 * Initiate an OAuth flow for a remote MCP server.
 * Returns the authorization URL to redirect the user to.
 */
export async function initiateOAuthFlow(
  mcpId: string,
  mcpUrl: string,
  redirectUri: string,
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
    return null
  }

  // Resolve client credentials: explicit override > stored > dynamic registration.
  let clientId: string | undefined
  let clientSecret: string | undefined
  let registeredScope: string | undefined

  // Check if we already have client credentials stored
  const [existing] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, mcpId))
    .limit(1)

  if (clientIdOverride) {
    clientId = clientIdOverride
    clientSecret = clientSecretOverride || undefined
  } else if (existing?.oauthClientId) {
    clientId = existing.oauthClientId
    clientSecret = existing.oauthClientSecret || undefined
  } else if (metadata.registration_endpoint) {
    const registration = await registerDynamicClient(
      metadata.registration_endpoint,
      redirectUri,
      clientNameOverride && clientNameOverride.length > 0 ? clientNameOverride : 'Superagent',
    )
    if (registration) {
      clientId = registration.clientId
      clientSecret = registration.clientSecret
      registeredScope = registration.scope
    }
  }

  if (!clientId) {
    console.error('[mcp/oauth] No client_id available')
    return null
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
  redirectUri: string,
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
    return null
  }

  let clientId: string | undefined
  let clientSecret: string | undefined
  let registeredScope: string | undefined

  if (clientIdOverride) {
    clientId = clientIdOverride
    clientSecret = clientSecretOverride || undefined
  } else if (metadata.registration_endpoint) {
    const registration = await registerDynamicClient(
      metadata.registration_endpoint,
      redirectUri,
      clientNameOverride && clientNameOverride.length > 0 ? clientNameOverride : 'Superagent',
    )
    if (registration) {
      clientId = registration.clientId
      clientSecret = registration.clientSecret
      registeredScope = registration.scope
    }
  }

  if (!clientId) {
    console.error('[mcp/oauth] No client_id available — provide an OAuth Client ID or use a server that supports dynamic registration')
    return null
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
): Promise<{ success: boolean; mcpId?: string }> {
  const flow = pendingOAuthFlows.get(state)
  if (!flow) {
    console.error('[mcp/oauth] No pending flow for state:', state)
    return { success: false }
  }

  const issuerValidation = validateAuthorizationResponseIssuer(flow, iss)
  if (!issuerValidation.valid) {
    console.error('[mcp/oauth] Authorization response issuer validation failed:', issuerValidation.error)
    return { success: false }
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

    const res = await fetch(flow.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) {
      const errorBody = await res.text()
      console.error('[mcp/oauth] Token exchange failed:', res.status, errorBody)
      return { success: false }
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
      return { success: true, mcpId: id }
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
      return { success: true, mcpId: flow.mcpId }
    }

    return { success: false }
  } catch (error) {
    console.error('[mcp/oauth] Token exchange error:', error)
    return { success: false }
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

    const res = await fetch(mcp.oauthTokenEndpoint, {
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
