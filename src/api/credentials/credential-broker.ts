import { randomUUID } from 'crypto'
import { ApplePasswordsProvider } from './apple-passwords-provider'
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
import { isManagedCredentialProvider, isPairableCredentialProvider } from './types'

const DEFAULT_SELECTION_TTL_MS = 5 * 60 * 1000

interface PendingSelection {
  scopeKey: string
  provider: CredentialProvider
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

  constructor(
    private readonly providers: CredentialProvider[] = [new ApplePasswordsProvider()],
    private readonly selectionTtlMs = DEFAULT_SELECTION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async suggest(
    scope: CredentialRequestScope,
    rawUrl: string,
    configuredProviderIds?: string[],
  ): Promise<CredentialSuggestionsResponse> {
    const context = normalizeCredentialContext(rawUrl)
    const key = scopeKey(scope)
    this.prune(key)

    // MVP uses the first configured provider. The broker contract deliberately
    // keeps this choice out of the renderer so additional providers can be
    // combined later without widening the secret boundary. Omitting the list
    // retains the old all-providers behavior for broker-only consumers; the
    // product route always passes the durable user configuration explicitly.
    const provider = configuredProviderIds === undefined
      ? this.providers[0]
      : this.providers.find((candidate) => configuredProviderIds.includes(candidate.id))
    if (!provider) {
      const installable = (await this.connectionStatuses())
        .some((connection) => connection.installable)
      return {
        provider: 'none',
        providerLabel: 'Password manager',
        status: 'unconfigured',
        installable,
        origin: context.origin,
        message: 'Connect a password manager to fill saved logins',
        suggestions: [],
      }
    }

    const result = await provider.list(context)
    const suggestions = result.items.map((item) => {
      const id = randomUUID()
      this.selections.set(id, {
        scopeKey: key,
        provider,
        context,
        item,
        expiresAt: this.now() + this.selectionTtlMs,
      })
      return {
        id,
        username: item.username,
        domain: item.domain,
        ...(item.title ? { title: item.title } : {}),
      }
    })

    return {
      provider: provider.id,
      providerLabel: provider.label,
      status: result.status,
      installable: true,
      origin: context.origin,
      ...(result.message ? { message: result.message } : {}),
      suggestions,
    }
  }

  async retrieve(
    scope: CredentialRequestScope,
    selectionId: string,
    currentUrl: string,
  ): Promise<{ credential: RetrievedCredential; expectedOrigin: string }> {
    this.prune()
    const selection = this.selections.get(selectionId)
    if (!selection || selection.scopeKey !== scopeKey(scope)) {
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

  /** Shut down every provider-owned process/session and invalidate selections. */
  async shutdown(): Promise<void> {
    this.selections.clear()
    const results = await Promise.allSettled(this.providers.flatMap((provider) =>
      isManagedCredentialProvider(provider) ? [provider.shutdown()] : [],
    ))
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[CredentialBroker] Provider shutdown failed:', result.reason)
      }
    }
  }

  private prune(scopeToReplace?: string): void {
    const now = this.now()
    for (const [id, selection] of this.selections) {
      if (selection.expiresAt <= now || selection.scopeKey === scopeToReplace) {
        this.selections.delete(id)
      }
    }
  }
}

export const credentialBroker = new CredentialBroker()
