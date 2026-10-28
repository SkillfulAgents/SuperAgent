import { BaseAccountProvider } from './base-account-provider'
import type { InitiateConnectionResult, ProviderConnection, ProviderConnectionListItem } from './base-account-provider'
import { resolveDisplayName } from './display-name-helpers'
import { getProviderSlug, getToolkitSlugFromProviderSlug } from './service-catalog'

const NANGO_API_BASE = 'https://api.nango.dev'

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
])

const SKIP_RESPONSE_HEADERS = new Set([
  'transfer-encoding',
  'content-encoding',
  'content-length',
])

interface CachedToken {
  accessToken: string
  providerConfigKey: string
  expiresAt: number
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

class NangoApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message)
    this.name = 'NangoApiError'
  }
}

export class NangoAccountProvider extends BaseAccountProvider {
  readonly name = 'nango' as const

  private secretKey: string
  private tokenCache = new Map<string, CachedToken>()

  constructor(opts: { secretKey: string }) {
    super()
    this.secretKey = opts.secretKey
  }

  async listConnections(userId?: string): Promise<ProviderConnectionListItem[]> {
    const response = await this.nangoFetch('/connections') as {
      connections: Array<{
        connection_id: string
        provider_config_key: string
        created_at?: string
        end_user?: { id: string }
        errors?: Array<{ type: string }>
      }>
    }

    const connections = Array.isArray(response?.connections) ? response.connections : []
    const result: ProviderConnectionListItem[] = []
    for (const conn of connections) {
      if (userId && conn.end_user?.id && conn.end_user.id !== userId) continue

      const toolkitSlug = getToolkitSlugFromProviderSlug(conn.provider_config_key, 'nango')
      if (!toolkitSlug) continue

      const hasErrors = Array.isArray(conn.errors) && conn.errors.length > 0
      const hasAuthError = hasErrors && conn.errors!.some((e) => e.type === 'auth')
      const status: ProviderConnectionListItem['status'] =
        hasAuthError ? 'FAILED' : hasErrors ? 'INACTIVE' : 'ACTIVE'

      result.push({ id: conn.connection_id, status, toolkitSlug, createdAt: conn.created_at })
    }
    return result
  }

  async initiateConnection(
    toolkitSlug: string,
    callbackUrl: string,
    userId?: string,
  ): Promise<InitiateConnectionResult> {
    const nangoSlug = getProviderSlug(toolkitSlug, 'nango')
    await this.ensureIntegration(nangoSlug, toolkitSlug)

    const response = await this.nangoFetch('/connect/sessions', {
      method: 'POST',
      body: JSON.stringify({
        end_user: { id: userId ?? 'default' },
        allowed_integrations: [nangoSlug],
      }),
    })

    const data = (response as { data: { token: string; connect_link: string } }).data

    return {
      connectionId: data.token,
      redirectUrl: data.connect_link,
    }
  }

  private async ensureIntegration(nangoSlug: string, toolkitSlug: string): Promise<void> {
    try {
      await this.nangoFetch(`/integrations/${encodeURIComponent(nangoSlug)}`)
    } catch (err) {
      if (err instanceof NangoApiError && err.statusCode === 404) {
        try {
          await this.nangoFetch('/integrations/quickstart', {
            method: 'POST',
            body: JSON.stringify({
              provider: nangoSlug,
              unique_key: nangoSlug,
              display_name: toolkitSlug,
            }),
          })
        } catch (createErr) {
          throw new NangoApiError(
            `Failed to auto-create "${toolkitSlug}" integration in Nango. Configure it manually at https://app.nango.dev with integration key "${nangoSlug}".`,
            createErr instanceof NangoApiError ? createErr.statusCode : 500,
          )
        }
        return
      }
      throw err
    }
  }

  async getConnection(connectionId: string, toolkitSlug?: string): Promise<ProviderConnection> {
    try {
      const nangoSlug = toolkitSlug ? getProviderSlug(toolkitSlug, 'nango') : undefined
      const qs = nangoSlug ? `?provider_config_key=${encodeURIComponent(nangoSlug)}` : ''
      const response = await this.nangoFetch(`/connections/${encodeURIComponent(connectionId)}${qs}`) as {
        connection_id: string
        errors?: Array<{ type: string }>
      }

      const hasErrors = Array.isArray(response.errors) && response.errors.length > 0
      const hasAuthError = hasErrors && response.errors!.some((e) => e.type === 'auth')

      return {
        id: response.connection_id,
        status: hasAuthError ? 'FAILED' : hasErrors ? 'INACTIVE' : 'ACTIVE',
      }
    } catch (err) {
      if (err instanceof NangoApiError && (err.statusCode === 404 || err.statusCode === 400)) {
        return { id: connectionId, status: 'FAILED' }
      }
      throw err
    }
  }

  async deleteConnection(connectionId: string, toolkitSlug?: string): Promise<void> {
    const nangoSlug = toolkitSlug ? getProviderSlug(toolkitSlug, 'nango') : undefined
    const qs = nangoSlug ? `?provider_config_key=${encodeURIComponent(nangoSlug)}` : ''
    await this.nangoFetch(`/connections/${encodeURIComponent(connectionId)}${qs}`, {
      method: 'DELETE',
    })
  }

  async makeApiCall(params: {
    providerConnectionId: string
    toolkitSlug: string
    targetUrl: string
    method: string
    headers: Headers
    body: ArrayBuffer | null
  }): Promise<Response> {
    const { accessToken } = await this.resolveToken(params.providerConnectionId, params.toolkitSlug)

    const forwardHeaders = new Headers()
    params.headers.forEach((value, key) => {
      if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        forwardHeaders.set(key, value)
      }
    })
    forwardHeaders.set('Authorization', `Bearer ${accessToken}`)

    const init: RequestInit = { method: params.method, headers: forwardHeaders }
    if (params.method !== 'GET' && params.method !== 'HEAD' && params.body) {
      init.body = params.body
    }

    const response = await fetch(params.targetUrl, init)

    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  }

  async getAccountDisplayName(
    connectionId: string,
    toolkitSlug: string,
    fallbackName: string,
  ): Promise<string> {
    return resolveDisplayName(
      (p) => this.makeApiCall(p),
      connectionId,
      toolkitSlug,
      fallbackName,
    )
  }

  private async resolveToken(connectionId: string, toolkitSlug: string): Promise<{ accessToken: string; providerConfigKey: string }> {
    const cached = this.tokenCache.get(connectionId)
    if (cached && cached.expiresAt > Date.now()) {
      return { accessToken: cached.accessToken, providerConfigKey: cached.providerConfigKey }
    }

    const nangoSlug = getProviderSlug(toolkitSlug, 'nango')
    const response = await this.nangoFetch(
      `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(nangoSlug)}&force_refresh=true`
    ) as {
      provider_config_key: string
      credentials: {
        type: string
        access_token?: string
        oauth_token?: string
        api_key?: string
        expires_at?: string
      }
    }

    const creds = response.credentials
    const accessToken =
      creds.access_token ?? creds.oauth_token ?? creds.api_key
    if (!accessToken) {
      throw new NangoApiError(`No access token in Nango connection ${connectionId}`, 404)
    }

    let ttl = DEFAULT_CACHE_TTL_MS
    if (creds.expires_at) {
      const expiresMs = new Date(creds.expires_at).getTime() - Date.now()
      ttl = Math.min(expiresMs - 60_000, DEFAULT_CACHE_TTL_MS)
    }
    ttl = Math.max(ttl, 30_000)

    this.tokenCache.set(connectionId, {
      accessToken,
      providerConfigKey: response.provider_config_key,
      expiresAt: Date.now() + ttl,
    })

    return { accessToken, providerConfigKey: response.provider_config_key }
  }

  private async nangoFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(options.headers)
    headers.set('Authorization', `Bearer ${this.secretKey}`)
    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/json')
    }

    const url = `${NANGO_API_BASE}${endpoint}`
    const response = await fetch(url, { ...options, headers })

    if (!response.ok) {
      let errorMessage = `Nango API error: ${response.status}`
      try {
        const body = await response.json() as {
          message?: string
          error?: {
            code?: string
            errors?: Array<{ message?: string }>
          }
        }
        const nestedMessage = body?.error?.errors?.[0]?.message
        const code = body?.error?.code
        if (nestedMessage) {
          errorMessage = code ? `${nestedMessage} (${code})` : nestedMessage
        } else if (body?.message) {
          errorMessage = body.message
        }
      } catch {
        // ignore
      }
      throw new NangoApiError(errorMessage, response.status)
    }

    if (response.status === 204) return {}
    return response.json()
  }
}
