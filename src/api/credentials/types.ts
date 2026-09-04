import type {
  CredentialProviderConnection,
  CredentialProviderStatus,
} from '@shared/lib/credentials/schemas'

export type {
  CredentialProviderConnection,
  CredentialProviderConnectionStatus,
  CredentialProviderRemediation,
  CredentialProviderStatus,
  CredentialSuggestion,
  CredentialSuggestionsResponse,
  PasswordManagerCard,
} from '@shared/lib/credentials/schemas'

export interface CredentialLookupContext {
  url: string
  origin: string
}

export interface CredentialProviderItem {
  providerKey: string
  username?: string
  domain?: string
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

export interface SearchableCredentialProvider extends CredentialProvider {
  search(query: string): Promise<CredentialProviderItem[]>
}

export function isSearchableCredentialProvider(
  provider: CredentialProvider,
): provider is SearchableCredentialProvider {
  return typeof (provider as Partial<SearchableCredentialProvider>).search === 'function'
}

export interface CredentialRequestScope {
  agentSlug: string
  sessionId: string
  toolUseId: string
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
