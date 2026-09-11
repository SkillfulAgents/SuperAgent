import { randomUUID } from 'crypto'
import { ApplePasswordsProvider } from './apple-passwords-provider'
import { OnePasswordProvider } from './onepassword-provider'
import type {
  CredentialLookupContext,
  CredentialProviderConnection,
  CredentialProvider,
  CredentialProviderItem,
  CredentialRequestScope,
  CredentialSuggestionsResponse,
  RetrievedCredential,
} from './types'
import { CredentialBrokerError } from './types'
import {
  isManagedCredentialProvider,
  isPairableCredentialProvider,
  isSearchableCredentialProvider,
} from './types'

const DEFAULT_SELECTION_TTL_MS = 5 * 60 * 1000

interface PendingSelection {
  scopeKey: string
  provider: CredentialProvider
  providerId: string
  kind: 'suggestion' | 'search'
  context: CredentialLookupContext
  item: CredentialProviderItem
  expiresAt: number
}

function scopeKey(scope: CredentialRequestScope): string {
  return `${scope.agentSlug}\n${scope.sessionId}\n${scope.toolUseId}`
}

export function normalizeCredentialContext(rawUrl: string): CredentialLookupContext {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new CredentialBrokerError('invalid_url', 'The active browser page does not have a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CredentialBrokerError('invalid_url', 'Credentials are only available for HTTP or HTTPS pages')
  }
  parsed.hash = ''
  return { url: parsed.toString(), origin: parsed.origin }
}

export class CredentialBroker {
  private readonly selections = new Map<string, PendingSelection>()
  private epoch = 0

  constructor(
    private readonly providers: CredentialProvider[] = [new ApplePasswordsProvider(), new OnePasswordProvider()],
    private readonly selectionTtlMs = DEFAULT_SELECTION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async suggest(
    scope: CredentialRequestScope,
    rawUrl: string,
    configuredProviderIds?: string[],
    query?: string,
  ): Promise<CredentialSuggestionsResponse> {
    const context = normalizeCredentialContext(rawUrl)
    const key = scopeKey(scope)
    const suggestEpoch = this.epoch
    this.prune(key, query === undefined ? 'suggestion' : 'search')

    // Single-select: the configured list holds at most one id. Omitting the
    // list retains the old all-providers behavior for broker-only consumers.
    const provider = configuredProviderIds === undefined
      ? this.providers[0]
      : this.providers.find((candidate) => configuredProviderIds.includes(candidate.id))
    const searchable = provider ? isSearchableCredentialProvider(provider) : false
    if (!provider) {
      const installable = (await this.connectionStatuses())
        .some((connection) => connection.installable)
      return {
        provider: 'none',
        providerLabel: 'Password manager',
        status: 'unconfigured',
        installable,
        searchable,
        origin: context.origin,
        message: 'Connect a password manager to fill saved logins',
        suggestions: [],
      }
    }

    if (query !== undefined) {
      if (!isSearchableCredentialProvider(provider)) {
        throw new CredentialBrokerError('provider_error', 'This password manager does not support search')
      }
      const items = await provider.search(query)
      return {
        provider: provider.id,
        providerLabel: provider.label,
        status: 'ready',
        installable: true,
        searchable,
        origin: context.origin,
        suggestions: suggestEpoch === this.epoch
          ? this.mint(key, provider, context, items, 'search')
          : [],
      }
    }

    const result = await provider.list(context)
    return {
      provider: provider.id,
      providerLabel: provider.label,
      status: result.status,
      installable: true,
      searchable,
      origin: context.origin,
      ...(result.message ? { message: result.message } : {}),
      suggestions: suggestEpoch === this.epoch
        ? this.mint(key, provider, context, result.items, 'suggestion')
        : [],
    }
  }

  async retrieve(
    scope: CredentialRequestScope,
    selectionId: string,
    currentUrl: string,
    configuredProviderIds?: string[],
  ): Promise<{ credential: RetrievedCredential; expectedOrigin: string }> {
    this.prune()
    const selection = this.selections.get(selectionId)
    if (!selection || selection.scopeKey !== scopeKey(scope)) {
      throw new CredentialBrokerError('selection_not_found', 'Refresh the available credentials and try again')
    }
    if (configuredProviderIds && !configuredProviderIds.includes(selection.providerId)) {
      throw new CredentialBrokerError('selection_not_found', 'Refresh the available credentials and try again')
    }

    const current = normalizeCredentialContext(currentUrl)
    if (current.origin !== selection.context.origin) {
      this.selections.delete(selectionId)
      throw new CredentialBrokerError('origin_changed', 'The browser page changed before autofill')
    }

    // One shot: a second fill requires another metadata lookup and user click.
    this.selections.delete(selectionId)
    const credential = await selection.provider.retrieve(selection.context, selection.item)
    return { credential, expectedOrigin: selection.context.origin }
  }

  async connectionStatuses(): Promise<CredentialProviderConnection[]> {
    return await Promise.all(this.providers.flatMap((provider) =>
      isPairableCredentialProvider(provider) ? [provider.connectionStatus()] : [],
    ))
  }

  hasProvider(providerId: string): boolean {
    return this.providers.some((provider) => provider.id === providerId)
  }

  warmingProviderId(configuredProviderIds: string[]): string | null {
    const provider = this.providers.find((candidate) => configuredProviderIds.includes(candidate.id))
    if (!provider) return null
    const candidate = provider as CredentialProvider & { isWarming?: () => boolean }
    return typeof candidate.isWarming === 'function' && candidate.isWarming() ? provider.id : null
  }

  providerLabel(providerId: string): string {
    return this.providers.find((candidate) => candidate.id === providerId)?.label ?? 'Password manager'
  }

  async beginPairing(providerId: string): Promise<{ status: 'ready' | 'pin_required' }> {
    const provider = this.providers.find((candidate) => candidate.id === providerId)
    if (!provider || !isPairableCredentialProvider(provider)) {
      throw new CredentialBrokerError('provider_error', 'The password manager does not support pairing')
    }
    return provider.beginPairing()
  }

  async completePairing(providerId: string, pin: string): Promise<void> {
    const provider = this.providers.find((candidate) => candidate.id === providerId)
    if (!provider || !isPairableCredentialProvider(provider)) {
      throw new CredentialBrokerError('provider_error', 'The password manager does not support pairing')
    }
    await provider.completePairing(pin)
  }

  /** Shut down managed providers and invalidate matching selections. */
  async shutdown(providerId?: string): Promise<void> {
    this.epoch++
    for (const [id, selection] of this.selections) {
      if (!providerId || selection.providerId === providerId) {
        this.selections.delete(id)
      }
    }
    const targets = this.providers
      .filter(isManagedCredentialProvider)
      .filter((provider) => !providerId || provider.id === providerId)
    const results = await Promise.allSettled(targets.map((provider) => provider.shutdown()))
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[CredentialBroker] Provider shutdown failed:', result.reason)
      }
    }
  }

  private mint(
    key: string,
    provider: CredentialProvider,
    context: CredentialLookupContext,
    items: CredentialProviderItem[],
    kind: 'suggestion' | 'search',
  ) {
    return items.map((item) => {
      const id = randomUUID()
      this.selections.set(id, {
        scopeKey: key,
        provider,
        providerId: provider.id,
        kind,
        context,
        item,
        expiresAt: this.now() + this.selectionTtlMs,
      })
      return {
        id,
        ...(item.username ? { username: item.username } : {}),
        ...(item.domain ? { domain: item.domain } : {}),
        ...(item.title ? { title: item.title } : {}),
      }
    })
  }

  private prune(scopeToReplace?: string, kind?: 'suggestion' | 'search'): void {
    const now = this.now()
    for (const [id, selection] of this.selections) {
      const expired = selection.expiresAt <= now
      const scopeMatched = scopeToReplace !== undefined && selection.scopeKey === scopeToReplace
      const kindMatched = kind === undefined || selection.kind === kind
      if (expired || (scopeMatched && kindMatched)) {
        this.selections.delete(id)
      }
    }
  }
}

export const credentialBroker = new CredentialBroker()
