/**
 * Composio API client for managing OAuth connections.
 */

import {
  getEffectiveComposioApiKey,
  getComposioUserId,
} from '@shared/lib/config/settings'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { addErrorBreadcrumb } from '@shared/lib/error-reporting'
import { ProxyExecuteResponseSchema } from './proxy-execute-schema'
import { LinkResponseSchema } from './link-response-schema'

const COMPOSIO_HOST = 'https://backend.composio.dev'

type ComposioApiVersion = 'v3' | 'v3.1'

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
 * Thrown by getConnectionToken when Composio returns a redacted token.
 * Callers should catch this and fall back to proxyExecute().
 */
class ComposioRedactedTokenError extends ComposioApiError {
  constructor(message: string, details?: ComposioError) {
    super(message, 403, details)
    this.name = 'ComposioRedactedTokenError'
  }
}

function getPlatformComposioBaseUrl(): string {
  return `${getPlatformProxyBaseUrl()}/v1/composio`
}

function getPlatformComposioToken(): string | null {
  return getPlatformAccessToken()
}

/**
 * Make a request to the Composio API.
 */
function shouldUseLocalComposioKey(): boolean {
  return Boolean(getEffectiveComposioApiKey())
}

async function composioFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  apiVersion: ComposioApiVersion = 'v3'
): Promise<T> {
  const localApiKey = getEffectiveComposioApiKey()
  const platformToken = localApiKey ? null : getPlatformComposioToken()
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')

  let url: string
  if (platformToken) {
    if (apiVersion !== 'v3' && apiVersion !== 'v3.1') {
      throw new ComposioApiError(
        `Platform Composio mode does not yet support API version ${apiVersion}. Configure a local Composio API key.`,
        501
      )
    }
    url = `${getPlatformComposioBaseUrl()}${endpoint}`
    headers.set('Authorization', `Bearer ${platformToken}`)
    headers.delete('x-api-key')
  } else if (localApiKey) {
    url = `${COMPOSIO_HOST}/api/${apiVersion}${endpoint}`
    headers.set('x-api-key', localApiKey)
  } else {
    throw new ComposioApiError('Composio API key is not configured', 401)
  }

  const response = await fetch(url, {
    ...options,
    headers,
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
  status: 'ENABLED' | 'DISABLED'
  createdAt: string
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
  status: 'ENABLED' | 'DISABLED'
  created_at: string
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
    status: 'ENABLED',
    createdAt: new Date().toISOString(),
  }
}

function mapAuthConfigListItem(item: AuthConfigListItem): AuthConfig {
  return {
    id: item.id,
    toolkitSlug: item.toolkit.slug,
    authScheme: item.auth_scheme,
    isComposioManaged: item.is_composio_managed,
    status: item.status,
    createdAt: item.created_at,
  }
}

/**
 * List auth configs for the current user. When `toolkitSlug` is provided,
 * Composio filters server-side — necessary to avoid pagination cutoff
 * hiding existing configs for the toolkit (Composio defaults to 20/page).
 */
export async function listAuthConfigs(
  toolkitSlug?: string,
): Promise<AuthConfig[]> {
  const query = toolkitSlug
    ? `?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=100`
    : ''
  const response = await composioFetch<ListAuthConfigsResponse>(
    `/auth_configs${query}`,
  )
  return (response.items || []).map(mapAuthConfigListItem)
}

/**
 * Get or create an auth config for a provider.
 * Uses Composio-managed OAuth credentials.
 */
export async function getOrCreateAuthConfig(
  providerSlug: string
): Promise<AuthConfig> {
  // First, check if an enabled auth config already exists for this provider
  const existing = await listAuthConfigs(providerSlug)
  const matchingConfigs = existing
    .filter((config) => config.status !== 'DISABLED')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  if (matchingConfigs.length > 0) {
    return matchingConfigs[0]
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
  toolkitSlug?: string
  createdAt?: string
}

// API response type for GET /connected_accounts/:id
interface ConnectedAccountGetResponse {
  id: string
  status: string
  created_at?: string
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

interface ListConnectedAccountsResponse {
  items: ConnectedAccountGetResponse[]
  next_cursor?: string
  total_pages?: number
}

/**
 * List all connected accounts for the current user.
 * Handles cursor-based pagination (Composio caps at 50/page).
 */
export async function listConnections(
  toolkit?: string,
  userIdOverride?: string
): Promise<ComposioConnection[]> {
  const useLocal = shouldUseLocalComposioKey()
  let baseEndpoint = '/connected_accounts?'
  if (useLocal || !getPlatformComposioToken()) {
    const userId = userIdOverride || getComposioUserId()
    if (!userId) {
      throw new ComposioApiError('Composio User ID is not configured', 401)
    }
    baseEndpoint += `user_ids=${encodeURIComponent(userId)}&`
  }

  if (toolkit) {
    baseEndpoint += `toolkit_slugs=${encodeURIComponent(toolkit)}&`
  }

  const all: ComposioConnection[] = []
  let cursor: string | undefined

  for (let page = 0; page < 20; page++) {
    const endpoint = baseEndpoint + (cursor ? `cursor=${encodeURIComponent(cursor)}` : '')
    const response = await composioFetch<ListConnectedAccountsResponse>(endpoint)

    for (const item of response.items || []) {
      all.push({
        id: item.id,
        status: item.status as ComposioConnection['status'],
        toolkitSlug: item.toolkit?.slug,
        createdAt: item.created_at,
      })
    }

    if (!response.next_cursor) break
    cursor = response.next_cursor
  }

  return all
}

interface InitiateConnectionResponse {
  connectionId: string
  redirectUrl: string
}

/**
 * Initiate a new OAuth connection via Composio's hosted consent flow.
 * `POST /connected_accounts/link` replaced `POST /connected_accounts` for
 * Composio-managed OAuth configs (rolled out 2026-04-22, full cutover 2026-07-03).
 * `user_id` is required for local API key users; platform proxy injects it
 * server-side so callers may omit it.
 */
export async function initiateConnection(
  authConfigId: string,
  callbackUrl: string,
  userIdOverride?: string
): Promise<InitiateConnectionResponse> {
  const userId = userIdOverride || getComposioUserId()
  if (!userId && shouldUseLocalComposioKey()) {
    throw new ComposioApiError(
      'Composio User ID is required to initiate a connection',
      401
    )
  }

  const raw = await composioFetch<unknown>('/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({
      auth_config_id: authConfigId,
      ...(userId ? { user_id: userId } : {}),
      callback_url: callbackUrl,
    }),
  })

  const parsed = LinkResponseSchema.parse(raw)

  return {
    connectionId: parsed.connected_account_id,
    redirectUrl: parsed.redirect_url,
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

type RedactionPattern = 'literal-redacted' | 'prefix-ellipsis' | 'asterisks' | 'angle-bracket'

function detectRedaction(token: string): RedactionPattern | null {
  const trimmed = token.trim()
  // Exact literal Composio emits for composio-managed auth configs (rolled out 2026-04-22).
  if (trimmed === 'REDACTED') return 'literal-redacted'
  // Short prefix-with-ellipsis shape emitted when "Mask Connected Account Secrets" is enabled,
  // e.g. "ya29.abc..." or "sk-liv...". Real tokens are comfortably longer than 20 chars.
  if (trimmed.endsWith('...') && trimmed.length < 20) return 'prefix-ellipsis'
  // Defensive: catch obvious placeholder shapes ("***", "********", "<redacted>") in case
  // Composio changes format again. Real OAuth tokens never look like these.
  if (/^\*+$/.test(trimmed)) return 'asterisks'
  if (/^<[^>]*redact[^>]*>$/i.test(trimmed)) return 'angle-bracket'
  return null
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

  const redactionPattern = detectRedaction(accessToken)
  if (redactionPattern) {
    addErrorBreadcrumb({
      category: 'composio',
      message: `Redacted token detected (${redactionPattern}) for connection ${connectionId}`,
      level: 'warning',
      data: {
        toolkit: response.toolkit?.slug ?? 'unknown',
        auth_scheme: String(authScheme ?? 'unknown'),
        is_composio_managed: String(response.auth_config?.is_composio_managed ?? 'unknown'),
        redaction_pattern: redactionPattern,
        connectionId,
      },
    })
    throw new ComposioRedactedTokenError(
      'Access token is redacted by Composio. Disable "Mask Connected Account Secrets" in the Composio project settings. If the connection uses a Composio-managed auth config, credentials are redacted regardless of that setting — migrate to a custom auth config (your own OAuth app) to retrieve actual credentials.'
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
// Proxy Execute
// ============================================================================

export interface ProxyExecuteParameter {
  name: string
  value: string
  type: 'query' | 'header'
}

export type ProxyExecuteBinaryBody =
  | { url: string }
  | { base64: string; content_type: string }

export interface ProxyExecuteParams {
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  connectedAccountId: string
  body?: unknown
  parameters?: ProxyExecuteParameter[]
  binaryBody?: ProxyExecuteBinaryBody
}

export interface ProxyExecuteResult {
  status: number
  data: unknown
  headers: Record<string, string>
  binaryData?: {
    url: string
    content_type: string
    size: number
    expires_at: string
  }
}

/**
 * Forward a request to an upstream API via Composio's proxy.
 * Composio attaches the connected account's auth server-side and forwards
 * the request. Use this for connections whose tokens are redacted (Composio-managed).
 */
export async function proxyExecute(
  p: ProxyExecuteParams
): Promise<ProxyExecuteResult> {
  const raw = await composioFetch<unknown>(
    '/tools/execute/proxy',
    {
      method: 'POST',
      body: JSON.stringify({
        endpoint: p.endpoint,
        method: p.method,
        connected_account_id: p.connectedAccountId,
        ...(p.body !== undefined ? { body: p.body } : {}),
        ...(p.parameters?.length ? { parameters: p.parameters } : {}),
        ...(p.binaryBody ? { binary_body: p.binaryBody } : {}),
      }),
    },
    'v3.1'
  )
  const parsed = ProxyExecuteResponseSchema.parse(raw)
  return {
    status: parsed.status,
    data: parsed.data,
    headers: parsed.headers,
    binaryData: parsed.binary_data,
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
 * Pick the upstream endpoint that exposes the user's email for a given
 * Google toolkit. Most toolkits include the `userinfo.email` scope, so
 * `/oauth2/v2/userinfo` works. Calendar-only OAuth scopes don't include
 * userinfo, so we use `calendarList/primary` instead — its `id` field is
 * the connected user's primary calendar email.
 */
function getGoogleEmailLookup(
  toolkitSlug: string
): { endpoint: string; field: 'email' | 'id' } | null {
  if (toolkitSlug === 'googlecalendar') {
    return {
      endpoint:
        'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary',
      field: 'id',
    }
  }
  if (
    [
      'gmail',
      'googledrive',
      'googlesheets',
      'googledocs',
      'googleslides',
      'googlemeet',
      'youtube',
    ].includes(toolkitSlug)
  ) {
    return {
      endpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
      field: 'email',
    }
  }
  return null
}

/**
 * Fetch user info from Google using an OAuth access token.
 * Returns the user's email address and (for userinfo endpoints) name/picture.
 */
export async function getGoogleUserInfo(
  accessToken: string,
  toolkitSlug: string = 'gmail'
): Promise<GoogleUserInfo | null> {
  const lookup = getGoogleEmailLookup(toolkitSlug)
  if (!lookup) return null
  try {
    const response = await fetch(lookup.endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      console.warn('Failed to fetch Google user info:', response.status)
      return null
    }

    const data = await response.json()
    const email = typeof data?.[lookup.field] === 'string' ? data[lookup.field] : ''
    if (!email) return null
    return {
      email,
      name: typeof data?.name === 'string' ? data.name : undefined,
      picture: typeof data?.picture === 'string' ? data.picture : undefined,
    }
  } catch (error) {
    console.warn('Error fetching Google user info:', error)
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

async function getGoogleUserInfoViaProxy(
  connectionId: string,
  toolkitSlug: string
): Promise<GoogleUserInfo | null> {
  const lookup = getGoogleEmailLookup(toolkitSlug)
  if (!lookup) return null
  try {
    const result = await proxyExecute({
      endpoint: lookup.endpoint,
      method: 'GET',
      connectedAccountId: connectionId,
    })
    if (result.status >= 400 || !isRecord(result.data)) return null
    const data = result.data
    const email = typeof data[lookup.field] === 'string' ? (data[lookup.field] as string) : ''
    if (!email) return null
    return {
      email,
      name: typeof data.name === 'string' ? data.name : undefined,
      picture: typeof data.picture === 'string' ? data.picture : undefined,
    }
  } catch (error) {
    console.warn('Error fetching Google user info via proxy:', error)
    return null
  }
}

async function getMicrosoftMailViaProxy(
  connectionId: string
): Promise<string | null> {
  try {
    const result = await proxyExecute({
      endpoint: 'https://graph.microsoft.com/v1.0/me',
      method: 'GET',
      connectedAccountId: connectionId,
    })
    if (result.status >= 400 || !isRecord(result.data)) return null
    const mail = result.data.mail
    const upn = result.data.userPrincipalName
    if (typeof mail === 'string' && mail) return mail
    if (typeof upn === 'string' && upn) return upn
    return null
  } catch (error) {
    console.warn('Error fetching Microsoft user info via proxy:', error)
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
  // Fetch user-specific info for providers that support it
  const googleToolkits = [
    'gmail',
    'googlecalendar',
    'googledrive',
    'googlesheets',
    'googledocs',
    'googleslides',
    'googlemeet',
    'googletasks',
    'youtube',
  ]
  const microsoftToolkits = ['outlook', 'microsoft_teams']

  const slug = toolkitSlug.toLowerCase()

  if (googleToolkits.includes(slug)) {
    try {
      const { accessToken } = await getConnectionToken(connectionId)
      const userInfo = await getGoogleUserInfo(accessToken, slug)
      if (userInfo?.email) return userInfo.email
    } catch (error) {
      if (error instanceof ComposioRedactedTokenError) {
        const userInfo = await getGoogleUserInfoViaProxy(connectionId, slug)
        if (userInfo?.email) return userInfo.email
      } else {
        console.warn('Could not fetch user info for display name:', error)
      }
    }
  } else if (microsoftToolkits.includes(slug)) {
    try {
      const { accessToken } = await getConnectionToken(connectionId)
      const res = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const profile = (await res.json()) as {
          mail?: string
          userPrincipalName?: string
        }
        if (profile.mail || profile.userPrincipalName) {
          return profile.mail || profile.userPrincipalName!
        }
      }
    } catch (error) {
      if (error instanceof ComposioRedactedTokenError) {
        const mail = await getMicrosoftMailViaProxy(connectionId)
        if (mail) return mail
      } else {
        console.warn(
          'Could not fetch Microsoft user info for display name:',
          error
        )
      }
    }
  }

  return fallbackName
}

/**
 * Check if the platform Composio integration is active.
 * Returns true when using org-managed Composio via the platform proxy,
 * false when using a local Composio API key or when not connected.
 */
export function isPlatformComposioActive(): boolean {
  return !shouldUseLocalComposioKey() && Boolean(getPlatformComposioToken())
}

export { ComposioApiError, ComposioRedactedTokenError }
