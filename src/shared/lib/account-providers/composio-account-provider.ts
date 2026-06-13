import { BaseAccountProvider } from './base-account-provider'
import type { InitiateConnectionResult, ProviderConnection, ProviderConnectionListItem } from './base-account-provider'
import { resolveDisplayName } from './display-name-helpers'
import {
  getOrCreateAuthConfig,
  initiateConnection as composioInitiateConnection,
  getConnection as composioGetConnection,
  deleteConnection as composioDeleteConnection,
  listConnections as composioListConnections,
  getConnectionToken,
  proxyExecute,
  ComposioRedactedTokenError,
} from '@shared/lib/composio/client'
import type { ProxyExecuteParams } from '@shared/lib/composio/client'
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

export class ComposioAccountProvider extends BaseAccountProvider {
  readonly name = 'composio' as const

  private connectionModeCache = new Map<string, ConnectionMode>()

  async listConnections(userId?: string): Promise<ProviderConnectionListItem[]> {
    const connections = await composioListConnections(undefined, userId)
    return connections
      .filter((c) => c.toolkitSlug)
      .map((c) => ({
        id: c.id,
        status: c.status,
        toolkitSlug: c.toolkitSlug!,
        createdAt: c.createdAt,
      }))
  }

  async initiateConnection(
    toolkitSlug: string,
    callbackUrl: string,
    userId?: string,
  ): Promise<InitiateConnectionResult> {
    const authConfig = await getOrCreateAuthConfig(toolkitSlug)
    return composioInitiateConnection(authConfig.id, callbackUrl, userId)
  }

  async getConnection(connectionId: string): Promise<ProviderConnection> {
    return composioGetConnection(connectionId)
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
  }): Promise<Response> {
    const mode = await this.resolveConnectionMode(params.providerConnectionId)

    if (mode.kind === 'token') {
      return this.directForward(mode.accessToken, params)
    }

    return this.proxyForward(params)
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
    connectionId: string
  ): Promise<ConnectionMode> {
    const cached = this.connectionModeCache.get(connectionId)
    if (cached && cached.cacheExpiresAt > Date.now()) {
      return cached
    }

    try {
      const { accessToken, expiresAt } = await getConnectionToken(connectionId)

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

  private async directForward(
    accessToken: string,
    params: {
      targetUrl: string
      method: string
      headers: Headers
      body: ArrayBuffer | null
    },
  ): Promise<Response> {
    const forwardHeaders = new Headers()
    params.headers.forEach((value, key) => {
      if (!PROXY_SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
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
  }): Promise<Response> {
    const parameters = buildProxyParameters(params.headers)

    const contentType = params.headers.get('Content-Type')
    const requestBuffer = params.body ?? new ArrayBuffer(0)
    const translation = translateProxyBody(params.method, contentType, requestBuffer)

    if (!translation.ok) {
      return new Response(
        JSON.stringify({ error: translation.errorCode, message: translation.message }),
        { status: translation.status, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const result = await proxyExecute({
      endpoint: params.targetUrl,
      method: params.method as ProxyExecuteParams['method'],
      connectedAccountId: params.providerConnectionId,
      ...(translation.body !== undefined ? { body: translation.body } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(translation.binaryBody ? { binaryBody: translation.binaryBody } : {}),
    })

    return envelopeToResponse(result)
  }
}
