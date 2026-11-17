import type { AppSettings } from '@shared/lib/config/settings'

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

/** The settings a provider's own credentials come from. */
export type AccountProviderSettings = Pick<AppSettings, 'apiKeys' | 'platformAuth'>

/**
 * The credentials a provider signs its own API calls with, taken from one
 * settings read for one operation (a proxied agent request) and handed to
 * each call in it, so the operation reads settings once. The next operation,
 * or a retry after waiting for a re-authentication, takes them again. Opaque
 * outside the provider that made them; a provider handed another provider's
 * credentials reads its own.
 */
export interface ProviderCredentials {
  readonly provider: ProviderName
}

export abstract class BaseAccountProvider {
  abstract readonly name: ProviderName

  /** This provider's credentials in `settings` (see {@link ProviderCredentials}). */
  abstract credentialsFrom(settings: AccountProviderSettings): ProviderCredentials

  /**
   * Whether the provider can be used right now (its credentials are set).
   * Read fresh on every call; an unconfigured provider stays registered but
   * is neither the default nor in the configured list.
   */
  async isConfigured(): Promise<boolean> {
    return true
  }

  abstract listConnections(userId?: string): Promise<ProviderConnectionListItem[]>

  abstract initiateConnection(
    toolkitSlug: string,
    callbackUrl: string,
    userId?: string,
  ): Promise<InitiateConnectionResult>

  abstract getConnection(
    connectionId: string,
    toolkitSlug?: string,
    credentials?: ProviderCredentials,
  ): Promise<ProviderConnection>

  abstract deleteConnection(connectionId: string, toolkitSlug?: string): Promise<void>

  /**
   * Forward an API call through this provider's auth. Handles token
   * retrieval or proxy routing internally. Returns a streaming Response.
   * `credentials`: the operation's (see {@link ProviderCredentials}); read
   * now when absent.
   */
  abstract makeApiCall(params: {
    providerConnectionId: string
    toolkitSlug: string
    targetUrl: string
    method: string
    headers: Headers
    body: ArrayBuffer | null
    credentials?: ProviderCredentials
  }): Promise<Response>

  abstract getAccountDisplayName(
    connectionId: string,
    toolkitSlug: string,
    fallbackName: string,
  ): Promise<string>
}
