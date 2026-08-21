import { getSettings } from '../config/settings'
import type { BaseWebProvider } from './base-web-provider'
import { ExaWebProvider } from './exa-web-provider'
import { PlatformWebProvider } from './platform-web-provider'
import type { WebProviderId } from './types'

type WebVendorId = Exclude<WebProviderId, 'native'>

const WEB_PROVIDERS: Record<WebVendorId, BaseWebProvider> = {
  exa: new ExaWebProvider(),
  platform: new PlatformWebProvider(),
}

function isVendorId(id: string): id is WebVendorId {
  return id !== 'native' && id in WEB_PROVIDERS
}

export function getWebProvider(id: WebVendorId): BaseWebProvider {
  return WEB_PROVIDERS[id]
}

/** Look up by untrusted id string; null for a miss. */
export function findWebProvider(id: string): BaseWebProvider | null {
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}

/**
 * Sticky like LLM/STT: a stored pin is a contract (broken credential fails loud).
 * Unset → Platform if Gamut login, else native. Exa is never auto-selected.
 */
export function resolveEffectiveWebVendor(): WebProviderId {
  const stored = getSettings().webProvider
  if (stored === 'native') return 'native'
  if (stored && isVendorId(stored)) return stored
  if (WEB_PROVIDERS.platform.getApiKeyStatus().isConfigured) return 'platform'
  return 'native'
}

/** Active host provider, or null when effective vendor is native. */
export function getActiveWebProvider(): BaseWebProvider | null {
  const id = resolveEffectiveWebVendor()
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}
