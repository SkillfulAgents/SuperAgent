import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { remoteMcpServers } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { OAuthMetadata, OAuthTokenResponse } from './types'

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

    // Step 2: Extract resource_metadata from WWW-Authenticate
    const wwwAuth = probeResponse.headers.get('WWW-Authenticate') || ''
    const resourceMetadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/)

    let authServerUrl: string
    let resource: string

    if (resourceMetadataMatch) {
      // RFC 9728: Fetch Protected Resource Metadata
      const resourceMetadataUrl = resourceMetadataMatch[1]
      const resourceRes = await fetch(resourceMetadataUrl)
      if (!resourceRes.ok) {
        throw new Error(`Failed to fetch resource metadata: ${resourceRes.status}`)
      }
      const resourceMetadata = (await resourceRes.json()) as {
        resource?: string
        authorization_servers?: string[]
      }
      resource = resourceMetadata.resource || new URL(mcpUrl).origin
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

    // Step 3: Fetch Authorization Server Metadata
    // Try RFC 8414 first, then OpenID Connect Discovery
    const wellKnownUrls = [
      `${authServerUrl}/.well-known/oauth-authorization-server`,
      `${authServerUrl}/.well-known/openid-configuration`,
    ]

    for (const url of wellKnownUrls) {
      try {
        const res = await fetch(url)
        if (res.ok) {
          const metadata = (await res.json()) as OAuthMetadata
          if (metadata.authorization_endpoint && metadata.token_endpoint) {
            return { metadata, resource }
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
): Promise<{ clientId: string; clientSecret?: string } | null> {
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
    }
    return { clientId: data.client_id, clientSecret: data.client_secret }
  } catch {
    return null
  }
}

// In-memory store for pending OAuth flows
const pendingOAuthFlows = new Map<
  string,
  {
    codeVerifier: string
    redirectUri: string
    resource: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    mcpId?: string
    newServer?: { name: string; url: string }
  }
>()

/**
 * Initiate an OAuth flow for a remote MCP server.
 * Returns the authorization URL to redirect the user to.
 */
export async function initiateOAuthFlow(
  mcpId: string,
  mcpUrl: string,
  redirectUri: string,
): Promise<{
  authorizationUrl: string
  state: string
} | null> {
  // Discover OAuth endpoints
  const discovery = await discoverOAuthMetadata(mcpUrl)
  if (!discovery) return null

  const { metadata, resource } = discovery

  // Verify S256 is supported
  const supportedMethods = metadata.code_challenge_methods_supported || []
  if (supportedMethods.length > 0 && !supportedMethods.includes('S256')) {
    console.error('[mcp/oauth] Server does not support S256 PKCE')
    return null
  }

  // Try dynamic client registration if available
  let clientId: string | undefined
  let clientSecret: string | undefined

  // Check if we already have client credentials stored
  const [existing] = await db
    .select()
    .from(remoteMcpServers)
    .where(eq(remoteMcpServers.id, mcpId))
    .limit(1)

  if (existing?.oauthClientId) {
    clientId = existing.oauthClientId
    clientSecret = existing.oauthClientSecret || undefined
  } else if (metadata.registration_endpoint) {
    const registration = await registerDynamicClient(
      metadata.registration_endpoint,
      redirectUri,
      'Superagent',
    )
    if (registration) {
      clientId = registration.clientId
      clientSecret = registration.clientSecret
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
    clientId,
    clientSecret,
    mcpId,
  })

  // Build authorization URL
  const authUrl = new URL(metadata.authorization_endpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('resource', resource)
  if (metadata.scopes_supported?.length) {
    authUrl.searchParams.set('scope', metadata.scopes_supported.join(' '))
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
): Promise<{
  authorizationUrl: string
  state: string
} | null> {
  const discovery = await discoverOAuthMetadata(mcpUrl)
  if (!discovery) return null

  const { metadata, resource } = discovery

  const supportedMethods = metadata.code_challenge_methods_supported || []
  if (supportedMethods.length > 0 && !supportedMethods.includes('S256')) {
    console.error('[mcp/oauth] Server does not support S256 PKCE')
    return null
  }

  let clientId: string | undefined
  let clientSecret: string | undefined

  if (metadata.registration_endpoint) {
    const registration = await registerDynamicClient(
      metadata.registration_endpoint,
      redirectUri,
      'Superagent',
    )
    if (registration) {
      clientId = registration.clientId
      clientSecret = registration.clientSecret
    }
  }

  if (!clientId) {
    console.error('[mcp/oauth] No client_id available (dynamic registration required for new servers)')
    return null
  }

  const { codeVerifier, codeChallenge } = generatePKCE()
  const state = crypto.randomBytes(16).toString('hex')

  pendingOAuthFlows.set(state, {
    codeVerifier,
    redirectUri,
    resource,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    clientSecret,
    newServer: { name, url: mcpUrl },
  })

  const authUrl = new URL(metadata.authorization_endpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('resource', resource)
  if (metadata.scopes_supported?.length) {
    authUrl.searchParams.set('scope', metadata.scopes_supported.join(' '))
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
): Promise<{ success: boolean; mcpId?: string }> {
  const flow = pendingOAuthFlows.get(state)
  if (!flow) {
    console.error('[mcp/oauth] No pending flow for state:', state)
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
