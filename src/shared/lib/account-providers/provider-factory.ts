import type { BaseAccountProvider, ProviderName } from './base-account-provider'
import { VALID_PROVIDER_NAMES } from './base-account-provider'
import { getDefaultAccountProviderType } from '@shared/lib/config/settings'

const providers = new Map<ProviderName, BaseAccountProvider>()

export function registerAccountProvider(provider: BaseAccountProvider): void {
  providers.set(provider.name, provider)
}

export function getAccountProvider(name: ProviderName): BaseAccountProvider {
  const p = providers.get(name)
  if (!p) throw new Error(`Account provider "${name}" is not registered`)
  return p
}

export function isValidProviderName(name: string): name is ProviderName {
  return VALID_PROVIDER_NAMES.includes(name as ProviderName)
}

export function getAccountProviderByName(name: string): BaseAccountProvider {
  if (!isValidProviderName(name)) {
    throw new Error(`Unknown account provider: "${name}". Valid providers: ${VALID_PROVIDER_NAMES.join(', ')}`)
  }
  return getAccountProvider(name)
}

/** The registered providers that are configured now (see `BaseAccountProvider.isConfigured`). */
export async function getRegisteredProviders(): Promise<BaseAccountProvider[]> {
  const registered = Array.from(providers.values())
  const configured = await Promise.all(registered.map((provider) => provider.isConfigured()))
  return registered.filter((_, index) => configured[index])
}

export async function getDefaultAccountProvider(): Promise<BaseAccountProvider> {
  const preferred = providers.get(await getDefaultAccountProviderType())
  if (preferred && await preferred.isConfigured()) return preferred
  const composio = providers.get('composio')
  if (composio) return composio
  const first = providers.values().next()
  if (first.done) throw new Error('No account providers registered')
  return first.value
}
