export type ProviderName = 'composio' | 'nango'
export const VALID_PROVIDER_NAMES: readonly ProviderName[] = ['composio', 'nango']

export interface InitiateConnectionResult {
  connectionId: string
  redirectUrl: string
}

export interface ProviderConnection {
  id: string
  status: 'ACTIVE' | 'INITIATED' | 'INITIALIZING' | 'FAILED' | 'EXPIRED' | 'INACTIVE'
}

export interface ProviderConnectionListItem {
  id: string
  status: ProviderConnection['status']
  toolkitSlug: string
  createdAt?: string
}

export abstract class BaseAccountProvider {
  abstract readonly name: ProviderName

  abstract listConnections(userId?: string): Promise<ProviderConnectionListItem[]>

  abstract initiateConnection(
    toolkitSlug: string,
    callbackUrl: string,
    userId?: string,
  ): Promise<InitiateConnectionResult>

  abstract getConnection(connectionId: string, toolkitSlug?: string): Promise<ProviderConnection>

  abstract deleteConnection(connectionId: string, toolkitSlug?: string): Promise<void>

  /**
   * Forward an API call through this provider's auth. Handles token
   * retrieval or proxy routing internally. Returns a streaming Response.
   */
  abstract makeApiCall(params: {
    providerConnectionId: string
    toolkitSlug: string
    targetUrl: string
    method: string
    headers: Headers
    body: ArrayBuffer | null
  }): Promise<Response>

  abstract getAccountDisplayName(
    connectionId: string,
    toolkitSlug: string,
    fallbackName: string,
  ): Promise<string>
}
