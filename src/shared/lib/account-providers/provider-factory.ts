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

export function getRegisteredProviders(): BaseAccountProvider[] {
  return Array.from(providers.values())
}

export function getDefaultAccountProvider(): BaseAccountProvider {
  const preferred = getDefaultAccountProviderType()
  const p = providers.get(preferred)
  if (p) return p
  const composio = providers.get('composio')
  if (composio) return composio
  const first = providers.values().next()
  if (first.done) throw new Error('No account providers registered')
  return first.value
}
