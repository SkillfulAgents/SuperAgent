import { BaseAccountProvider } from './base-account-provider'
import type {
  AccountProviderSettings,
  InitiateConnectionResult,
  ProviderConnection,
  ProviderConnectionListItem,
  ProviderCredentials,
} from './base-account-provider'
import { resolveDisplayName } from './display-name-helpers'
import { getProviderSlug, getToolkitSlugFromProviderSlug } from './service-catalog'
import {
  getOrCreateAuthConfig,
  initiateConnection as composioInitiateConnection,
  getConnection as composioGetConnection,
  deleteConnection as composioDeleteConnection,
  listConnections as composioListConnections,
  getConnectionToken,
  proxyExecute,
  composioAuthFrom,
  resolveComposioAuth,
  ComposioRedactedTokenError,
} from '@shared/lib/composio/client'
import type { ComposioAuth, ProxyExecuteParams } from '@shared/lib/composio/client'
import {
  buildProxyParameters,
  envelopeToResponse,
  PROXY_SKIP_REQUEST_HEADERS,
  PROXY_SKIP_RESPONSE_HEADERS,
} from '@shared/lib/proxy/composio-envelope'
import { translateProxyBody } from '@shared/lib/proxy/body-translation'

type ConnectionMode =
  | { kind: 'token'; accessToken: string; cacheExpiresAt: number }
  | { kind: 'use-proxy'; cacheExpiresAt: number }

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

interface ComposioCredentials extends ProviderCredentials {
  readonly provider: 'composio'
  readonly auth: ComposioAuth
}

/** The Composio auth in `credentials` when this provider made them; undefined (read at the call) otherwise. */
function composioAuthOf(credentials?: ProviderCredentials): ComposioAuth | undefined {
  return credentials?.provider === 'composio' ? (credentials as ComposioCredentials).auth : undefined
}

/** A Google Drive resumable upload session link, which carries its own authorization. */
function isDriveUploadSession(toolkitSlug: string, method: string, targetUrl: string): boolean {
  const url = URL.parse(targetUrl)
  return toolkitSlug === 'googledrive' && method === 'PUT' && url?.protocol === 'https:' && url.hostname === 'www.googleapis.com'
    && url.pathname.startsWith('/upload/drive/') && !!url.searchParams.get('upload_id')
}

export class ComposioAccountProvider extends BaseAccountProvider {
  readonly name = 'composio' as const

  private connectionModeCache = new Map<string, ConnectionMode>()
  /** Token reads in flight, shared by the calls that miss the cache together. */
  private pendingModes = new Map<string, Promise<ConnectionMode>>()

  credentialsFrom(settings: AccountProviderSettings): ProviderCredentials {
    const credentials: ComposioCredentials = { provider: 'composio', auth: composioAuthFrom(settings) }
    return credentials
  }

  async listConnections(userId?: string): Promise<ProviderConnectionListItem[]> {
    const connections = await composioListConnections(undefined, userId)
    return connections
      .filter((c) => c.toolkitSlug)
      .map((c) => ({
        id: c.id,
        status: c.status,
        toolkitSlug: getToolkitSlugFromProviderSlug(c.toolkitSlug!, 'composio') ?? c.toolkitSlug!,
        createdAt: c.createdAt,
      }))
  }

  async initiateConnection(
    toolkitSlug: string,
    callbackUrl: string,
    userId?: string,
  ): Promise<InitiateConnectionResult> {
    // One credential for the auth-config lookup and the link.
    const auth = await resolveComposioAuth()
    const authConfig = await getOrCreateAuthConfig(getProviderSlug(toolkitSlug, 'composio'), auth)
    return composioInitiateConnection(authConfig.id, callbackUrl, userId, auth)
  }

  async getConnection(connectionId: string, _toolkitSlug?: string, credentials?: ProviderCredentials): Promise<ProviderConnection> {
    return composioGetConnection(connectionId, composioAuthOf(credentials))
  }

  async deleteConnection(connectionId: string): Promise<void> {
    return composioDeleteConnection(connectionId)
  }

  async makeApiCall(params: {
    providerConnectionId: string
    toolkitSlug: string
    targetUrl: string
    method: string
    headers: Headers
    body: ArrayBuffer | null
    credentials?: ProviderCredentials
  }): Promise<Response> {
    // The call's credentials, else one read shared by the token lookup and the
    // forward, made only when one of them goes to Composio (a cached token
    // goes straight to the upstream).
    const given = composioAuthOf(params.credentials)
    let resolving: Promise<ComposioAuth> | undefined
    const auth = () => given ? Promise.resolve(given) : (resolving ??= resolveComposioAuth())
    const mode = await this.resolveConnectionMode(params.providerConnectionId, auth)

    if (mode.kind === 'token') {
      return this.directForward(mode.accessToken, params)
    }
    // The link authorizes its own upload, so its bytes skip the proxy and its body limit.
    if (isDriveUploadSession(params.toolkitSlug, params.method, params.targetUrl)) {
      return this.directForward(null, params)
    }

    return this.proxyForward(params, auth)
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

  private async resolveConnectionMode(
    connectionId: string,
    auth: () => Promise<ComposioAuth>,
  ): Promise<ConnectionMode> {
    const cached = this.connectionModeCache.get(connectionId)
    if (cached && cached.cacheExpiresAt > Date.now()) {
      return cached
    }

    let pending = this.pendingModes.get(connectionId)
    if (!pending) {
      pending = this.readConnectionMode(connectionId, auth).finally(() => this.pendingModes.delete(connectionId))
      this.pendingModes.set(connectionId, pending)
    }
    return pending
  }

  private async readConnectionMode(
    connectionId: string,
    auth: () => Promise<ComposioAuth>,
  ): Promise<ConnectionMode> {
    try {
      const { accessToken, expiresAt } = await getConnectionToken(connectionId, await auth())

      let ttl = DEFAULT_CACHE_TTL_MS
      if (expiresAt) {
        const tokenExpiresMs = new Date(expiresAt).getTime() - Date.now()
        ttl = Math.min(tokenExpiresMs - 60_000, DEFAULT_CACHE_TTL_MS)
      }
      ttl = Math.max(ttl, 30_000)

      const mode: ConnectionMode = {
        kind: 'token',
        accessToken,
        cacheExpiresAt: Date.now() + ttl,
      }
      this.connectionModeCache.set(connectionId, mode)
      return mode
    } catch (err) {
      if (err instanceof ComposioRedactedTokenError) {
        const mode: ConnectionMode = {
          kind: 'use-proxy',
          cacheExpiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
        }
        this.connectionModeCache.set(connectionId, mode)
        return mode
      }
      throw err
    }
  }

  /** Without a token the target authorizes itself: cookies stay behind and a redirect is returned, never followed. */
  private async directForward(
    accessToken: string | null,
    params: {
      targetUrl: string
      method: string
      headers: Headers
      body: ArrayBuffer | null
    },
  ): Promise<Response> {
    const forwardHeaders = new Headers()
    params.headers.forEach((value, key) => {
      if (!PROXY_SKIP_REQUEST_HEADERS.has(key.toLowerCase()) && (accessToken || key.toLowerCase() !== 'cookie')) {
        forwardHeaders.set(key, value)
      }
    })
    if (accessToken) forwardHeaders.set('Authorization', `Bearer ${accessToken}`)

    const init: RequestInit = { method: params.method, headers: forwardHeaders, redirect: accessToken ? 'follow' : 'manual' }
    if (params.method !== 'GET' && params.method !== 'HEAD' && params.body) {
      init.body = params.body
    }

    const response = await fetch(params.targetUrl, init)

    const responseHeaders = new Headers()
    response.headers.forEach((value, key) => {
      if (!PROXY_SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    })

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    })
  }

  private async proxyForward(params: {
    providerConnectionId: string
    targetUrl: string
    method: string
    headers: Headers
    body: ArrayBuffer | null
  }, auth: () => Promise<ComposioAuth>): Promise<Response> {
    const contentType = params.headers.get('Content-Type')
    const requestBuffer = params.body ?? new ArrayBuffer(0)
    const translation = translateProxyBody(params.method, contentType, requestBuffer)

    if (!translation.ok) {
      return new Response(
        JSON.stringify({ error: translation.errorCode, message: translation.message }),
        { status: translation.status, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const headers = new Headers(params.headers)
    // Composio sets Content-Type from binary_body.content_type. Forwarding it
    // as a parameter too produces duplicate upstream headers (Dropbox rejects
    // the upload with HTTP 400). Keep the caller's headers intact for retries.
    if (translation.binaryBody) headers.delete('Content-Type')
    const parameters = buildProxyParameters(headers)

    const result = await proxyExecute({
      endpoint: params.targetUrl,
      method: params.method as ProxyExecuteParams['method'],
      connectedAccountId: params.providerConnectionId,
      ...(translation.body !== undefined ? { body: translation.body } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(translation.binaryBody ? { binaryBody: translation.binaryBody } : {}),
    }, await auth())

    return envelopeToResponse(result)
  }
}
