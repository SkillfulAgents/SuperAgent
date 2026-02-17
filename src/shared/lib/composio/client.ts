/**
 * Composio API client for managing OAuth connections.
 */

import {
  getEffectiveComposioApiKey,
  getComposioUserId,
} from '@shared/lib/config/settings'

const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3'

interface ComposioError {
  error: string | { message?: string; slug?: string; suggested_fix?: string }
  message?: string
}

class ComposioApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public details?: ComposioError
  ) {
    super(message)
    this.name = 'ComposioApiError'
  }
}

/**
 * Make a request to the Composio API.
 */
async function composioFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const apiKey = getEffectiveComposioApiKey()
  if (!apiKey) {
    throw new ComposioApiError('Composio API key is not configured', 401)
  }

  const url = `${COMPOSIO_BASE_URL}${endpoint}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      ...options.headers,
    },
  })

  if (!response.ok) {
    let errorDetails: ComposioError | undefined
    try {
      errorDetails = await response.json()
    } catch {
      // Ignore JSON parse errors
    }
    // Extract message from nested error object if present
    const errorMessage =
      errorDetails?.message ||
      (typeof errorDetails?.error === 'object' ? errorDetails.error.message : undefined) ||
      `Composio API error: ${response.status}`

    throw new ComposioApiError(
      errorMessage,
      response.status,
      errorDetails
    )
  }

  return response.json()
}

// ============================================================================
// Auth Configs
// ============================================================================

export interface AuthConfig {
  id: string
  toolkitSlug: string
  authScheme: string
  isComposioManaged: boolean
}

// API response types for POST (create) - nested structure
interface AuthConfigCreateResponse {
  toolkit: {
    slug: string
  }
  auth_config: {
    id: string
    auth_scheme: string
    is_composio_managed: boolean
    restrict_to_following_tools?: string[]
  }
}

// API response types for GET (list)
interface AuthConfigListItem {
  id: string
  auth_scheme: string
  is_composio_managed: boolean
  toolkit: {
    slug: string
    logo?: string
  }
}

interface ListAuthConfigsResponse {
  items: AuthConfigListItem[]
}

function mapAuthConfigCreateResponse(response: AuthConfigCreateResponse): AuthConfig {
  return {
    id: response.auth_config.id,
    toolkitSlug: response.toolkit.slug,
    authScheme: response.auth_config.auth_scheme,
    isComposioManaged: response.auth_config.is_composio_managed,
  }
}

function mapAuthConfigListItem(item: AuthConfigListItem): AuthConfig {
  return {
    id: item.id,
    toolkitSlug: item.toolkit.slug,
    authScheme: item.auth_scheme,
    isComposioManaged: item.is_composio_managed,
  }
}

/**
 * List all auth configs for the current user.
 */
export async function listAuthConfigs(): Promise<AuthConfig[]> {
  const response = await composioFetch<ListAuthConfigsResponse>('/auth_configs')
  return (response.items || []).map(mapAuthConfigListItem)
}

/**
 * Get or create an auth config for a provider.
 * Uses Composio-managed OAuth credentials.
 */
export async function getOrCreateAuthConfig(
  providerSlug: string
): Promise<AuthConfig> {
  // First, check if an auth config already exists for this provider
  const existing = await listAuthConfigs()
  const existingConfig = existing.find(
    (config) => config.toolkitSlug.toLowerCase() === providerSlug.toLowerCase()
  )

  if (existingConfig) {
    return existingConfig
  }

  // Create a new auth config with Composio-managed OAuth
  const response = await composioFetch<AuthConfigCreateResponse>('/auth_configs', {
    method: 'POST',
    body: JSON.stringify({
      toolkit: {
        slug: providerSlug,
      },
      auth_config: {
        type: 'use_composio_managed_auth',
      },
    }),
  })

  return mapAuthConfigCreateResponse(response)
}

// ============================================================================
// Connected Accounts
// ============================================================================

export interface ComposioConnection {
  id: string
  status: 'ACTIVE' | 'INITIATED' | 'INITIALIZING' | 'FAILED' | 'EXPIRED' | 'INACTIVE'
}

// API response type for GET /connected_accounts/:id
interface ConnectedAccountGetResponse {
  id: string
  status: string
  toolkit: {
    slug: string
  }
  auth_config: {
    id: string
    auth_scheme: string
    is_composio_managed: boolean
  }
  data?: {
    redirectUrl?: string
    [key: string]: unknown
  }
}

// API response type for POST /connected_accounts (initiate)
interface ConnectedAccountInitiateResponse {
  id: string
  status: string
  data?: {
    redirectUrl?: string
    [key: string]: unknown
  }
  redirect_url?: string | null
}

interface ListConnectedAccountsResponse {
  items: ConnectedAccountGetResponse[]
}

/**
 * List all connected accounts for the current user.
 */
export async function listConnections(
  toolkit?: string
): Promise<ComposioConnection[]> {
  const userId = getComposioUserId()
  if (!userId) {
    throw new ComposioApiError('Composio User ID is not configured', 401)
  }

  let endpoint = `/connected_accounts?user_id=${encodeURIComponent(userId)}`
  if (toolkit) {
    endpoint += `&toolkit_slug=${encodeURIComponent(toolkit)}`
  }

  const response = await composioFetch<ListConnectedAccountsResponse>(endpoint)
  return (response.items || []).map((item) => ({
    id: item.id,
    status: item.status as ComposioConnection['status'],
  }))
}

interface InitiateConnectionResponse {
  connectionId: string
  redirectUrl: string
}

/**
 * Initiate a new OAuth connection.
 * Returns a redirect URL for the OAuth flow.
 */
export async function initiateConnection(
  authConfigId: string,
  callbackUrl: string
): Promise<InitiateConnectionResponse> {
  const userId = getComposioUserId()
  if (!userId) {
    throw new ComposioApiError('Composio User ID is not configured', 401)
  }

  const response = await composioFetch<ConnectedAccountInitiateResponse>(
    '/connected_accounts',
    {
      method: 'POST',
      body: JSON.stringify({
        auth_config: {
          id: authConfigId,
        },
        connection: {
          state: {
            authScheme: 'OAUTH2',
            val: {
              status: 'INITIALIZING',
            },
          },
          user_id: userId,
          callback_url: callbackUrl,
        },
      }),
    }
  )

  // The redirect URL may be in data.redirectUrl or redirect_url
  const redirectUrl = response.data?.redirectUrl || response.redirect_url
  if (!redirectUrl) {
    throw new ComposioApiError('No redirect URL returned from Composio', 500)
  }

  return {
    connectionId: response.id,
    redirectUrl,
  }
}

/**
 * Get a specific connection by ID.
 */
export async function getConnection(
  connectionId: string
): Promise<ComposioConnection> {
  const response = await composioFetch<ConnectedAccountGetResponse>(
    `/connected_accounts/${connectionId}`
  )
  return {
    id: response.id,
    status: response.status as ComposioConnection['status'],
  }
}

/**
 * Delete a connection.
 */
export async function deleteConnection(connectionId: string): Promise<void> {
  await composioFetch(`/connected_accounts/${connectionId}`, {
    method: 'DELETE',
  })
}

// ============================================================================
// Access Tokens
// ============================================================================

interface ConnectionTokenResponse {
  accessToken: string
  expiresAt?: string
}

// Extended response type that includes token data
interface ConnectedAccountWithTokenResponse extends ConnectedAccountGetResponse {
  state?: {
    authScheme: string
    val: {
      status?: string
      access_token?: string
      oauth_token?: string
      oauth_token_secret?: string
      api_key?: string
      generic_api_key?: string
      token?: string
      expires_in?: number
      [key: string]: unknown
    }
  }
}

/**
 * Get the access token for a connection.
 * Use this to pass tokens to agent containers.
 * The token is in state.val based on the auth scheme.
 */
export async function getConnectionToken(
  connectionId: string
): Promise<ConnectionTokenResponse> {
  const response = await composioFetch<ConnectedAccountWithTokenResponse>(
    `/connected_accounts/${connectionId}`
  )

  const authScheme = response.state?.authScheme
  const stateVal = response.state?.val

  if (!stateVal) {
    throw new ComposioApiError('No state data found in connection', 404)
  }

  // Extract access token based on auth scheme
  let accessToken: string | undefined
  if (authScheme === 'OAUTH2') {
    accessToken = stateVal.access_token
  } else if (authScheme === 'OAUTH1') {
    accessToken = stateVal.oauth_token
  } else if (authScheme === 'API_KEY') {
    accessToken = stateVal.api_key || stateVal.generic_api_key
  } else if (authScheme === 'BEARER_TOKEN') {
    accessToken = stateVal.token
  } else {
    // Fallback to access_token
    accessToken = stateVal.access_token
  }

  if (!accessToken) {
    throw new ComposioApiError(`No access token found for auth scheme: ${authScheme}`, 404)
  }

  // Check for redacted tokens (Composio masks tokens when "Mask Connected Account Secrets" is enabled)
  if (accessToken.endsWith('...') && accessToken.length < 20) {
    throw new ComposioApiError(
      'Access token is redacted by Composio. Please go to Composio Settings > Project Settings > Project Configuration and disable "Mask Connected Account Secrets" to retrieve actual credentials.',
      403
    )
  }

  // Calculate expiry if expires_in is provided
  let expiresAt: string | undefined
  if (stateVal.expires_in) {
    const expiryDate = new Date(Date.now() + stateVal.expires_in * 1000)
    expiresAt = expiryDate.toISOString()
  }

  return {
    accessToken,
    expiresAt,
  }
}

// ============================================================================
// Provider-specific User Info
// ============================================================================

interface GoogleUserInfo {
  email: string
  name?: string
  picture?: string
}

/**
 * Fetch user info from Google using an OAuth access token.
 * Returns the user's email address and name if available.
 */
export async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      console.warn('Failed to fetch Google user info:', response.status)
      return null
    }

    const data = await response.json()
    return {
      email: data.email,
      name: data.name,
      picture: data.picture,
    }
  } catch (error) {
    console.warn('Error fetching Google user info:', error)
    return null
  }
}

/**
 * Get a display name for a newly connected account.
 * For supported providers, fetches user-specific info (like email).
 * Falls back to provider display name if fetch fails.
 */
export async function getAccountDisplayName(
  connectionId: string,
  toolkitSlug: string,
  fallbackName: string
): Promise<string> {
  // Only fetch user info for supported providers
  const googleToolkits = ['gmail', 'googlecalendar', 'googledrive']

  if (googleToolkits.includes(toolkitSlug.toLowerCase())) {
    try {
      const { accessToken } = await getConnectionToken(connectionId)
      const userInfo = await getGoogleUserInfo(accessToken)
      if (userInfo?.email) {
        return userInfo.email
      }
    } catch (error) {
      console.warn('Could not fetch user info for display name:', error)
    }
  }

  return fallbackName
}

export { ComposioApiError }
