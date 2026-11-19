import { getSettings, type AppSettings } from '../config/settings'
import type { BaseWebProvider } from './base-web-provider'
import { ExaWebProvider } from './exa-web-provider'
import { ParallelWebProvider } from './parallel-web-provider'
import { PlatformWebProvider } from './platform-web-provider'
import type { WebProviderId } from './types'

type WebVendorId = Exclude<WebProviderId, 'native'>

const WEB_PROVIDERS: Record<WebVendorId, BaseWebProvider> = {
  exa: new ExaWebProvider(),
  parallel: new ParallelWebProvider(),
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
export async function resolveEffectiveWebVendor(): Promise<WebProviderId> {
  return resolveEffectiveWebVendorFrom(await getSettings())
}

/** {@link resolveEffectiveWebVendor} from settings the caller already read. */
export function resolveEffectiveWebVendorFrom(settings: Pick<AppSettings, 'webProvider' | 'apiKeys' | 'platformAuth'>): WebProviderId {
  const stored = settings.webProvider
  if (stored === 'native') return 'native'
  if (stored && isVendorId(stored)) return stored
  if (WEB_PROVIDERS.platform.apiKeyStatusFrom(settings).isConfigured) return 'platform'
  return 'native'
}

/** Active host provider, or null when effective vendor is native. */
export async function getActiveWebProvider(): Promise<BaseWebProvider | null> {
  return activeWebProviderFrom(await getSettings())
}

/** {@link getActiveWebProvider} from settings the caller already read. */
export function activeWebProviderFrom(settings: Pick<AppSettings, 'webProvider' | 'apiKeys' | 'platformAuth'>): BaseWebProvider | null {
  const id = resolveEffectiveWebVendorFrom(settings)
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}
