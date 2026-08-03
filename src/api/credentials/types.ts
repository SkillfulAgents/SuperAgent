export type CredentialProviderStatus =
  | 'unconfigured'
  | 'ready'
  | 'unavailable'
  | 'locked'
  | 'error'

export interface CredentialLookupContext {
  url: string
  origin: string
}

export interface CredentialProviderItem {
  providerKey: string
  username: string
  domain: string
  title?: string
}

export interface RetrievedCredential {
  username: string
  password: string
}

export interface CredentialProviderResult {
  status: CredentialProviderStatus
  message?: string
  items: CredentialProviderItem[]
}

export interface CredentialProvider {
  readonly id: string
  readonly label: string
  list(context: CredentialLookupContext): Promise<CredentialProviderResult>
  retrieve(context: CredentialLookupContext, item: CredentialProviderItem): Promise<RetrievedCredential>
}

/** Optional lifecycle contract for providers that own local processes or sessions. */
export interface ManagedCredentialProvider extends CredentialProvider {
  shutdown(): Promise<void> | void
}

export function isManagedCredentialProvider(
  provider: CredentialProvider,
): provider is ManagedCredentialProvider {
  return typeof (provider as Partial<ManagedCredentialProvider>).shutdown === 'function'
}

export interface PairableCredentialProvider extends CredentialProvider {
  /** Pure capability/session probe; must not launch, unlock, or pair the provider. */
  connectionStatus(): Promise<CredentialProviderConnection>
  beginPairing(): Promise<{ status: 'ready' | 'pin_required' }>
  completePairing(pin: string): Promise<void>
}

export function isPairableCredentialProvider(
  provider: CredentialProvider,
): provider is PairableCredentialProvider {
  const candidate = provider as Partial<PairableCredentialProvider>
  return typeof candidate.connectionStatus === 'function' &&
    typeof candidate.beginPairing === 'function' &&
    typeof candidate.completePairing === 'function'
}

export type CredentialProviderConnectionStatus =
  | 'connected'
  | 'disconnected'
  | 'unavailable'
  | 'error'

export interface CredentialProviderRemediation {
  code: string
  title: string
  instructions: string[]
  action?: {
    kind: 'open_url' | 'open_in_chrome'
    label: string
    url: string
  }
}

export interface CredentialProviderConnection {
  provider: string
  providerLabel: string
  /** Whether this provider can be configured on the current host. */
  installable: boolean
  status: CredentialProviderConnectionStatus
  message?: string
  remediation?: CredentialProviderRemediation
}

export interface CredentialRequestScope {
  agentSlug: string
  sessionId: string
  toolUseId: string
}

export interface CredentialSuggestion {
  id: string
  username: string
  domain: string
  title?: string
}

export interface CredentialSuggestionsResponse {
  provider: string
  providerLabel: string
  status: CredentialProviderStatus
  /** False when no provider can be configured on this host. */
  installable: boolean
  origin: string
  message?: string
  suggestions: CredentialSuggestion[]
}

export class CredentialBrokerError extends Error {
  constructor(
    public readonly code: 'invalid_url' | 'selection_not_found' | 'origin_changed' | 'provider_locked' | 'provider_error',
    message: string,
  ) {
    super(message)
    this.name = 'CredentialBrokerError'
  }
}
