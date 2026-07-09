import { getSettings } from '../config/settings'
import type { BaseWebProvider } from './base-web-provider'
import { ExaWebProvider } from './exa-web-provider'
import { PlatformWebProvider } from './platform-web-provider'
import type { WebProviderId } from './types'

// Every non-native vendor id maps to its one provider (both search + fetch). A Record (not a Map)
// so adding a vendor to the union without wiring it here is a COMPILE error — the same compile-time
// exhaustiveness the LlmProvider / SttProvider registries rely on. 'native' is the no-host-provider
// sentinel and is intentionally absent. Constructors take no key (resolved per call), so eager
// construction is safe.
type WebVendorId = Exclude<WebProviderId, 'native'>

const WEB_PROVIDERS: Record<WebVendorId, BaseWebProvider> = {
  exa: new ExaWebProvider(),
  platform: new PlatformWebProvider(),
}

/** Runtime narrow (not a cast) of an arbitrary id string to a registered vendor id. */
function isVendorId(id: string): id is WebVendorId {
  return id !== 'native' && id in WEB_PROVIDERS
}

/** The provider for a known vendor id. */
export function getWebProvider(id: WebVendorId): BaseWebProvider {
  return WEB_PROVIDERS[id]
}

/**
 * Look up a provider by an untrusted id string (e.g. a request body field); null for a miss.
 * Narrows on a runtime check rather than casting.
 */
export function findWebProvider(id: string): BaseWebProvider | null {
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}

// Priority order for the automatic default. Extend by APPENDING a vendor id (open-to-extension).
const DEFAULT_VENDOR_PRIORITY: WebVendorId[] = ['platform', 'exa']

/**
 * The automatic default when the user has not chosen a vendor: the first one whose provider reports
 * a configured credential — reusing each provider's own detection, so 'platform' means signed into
 * Gamut and 'exa' means a key in settings or EXA_API_KEY in the environment — else 'native'.
 *
 * This diverges from the opt-in llm/stt siblings on purpose. The Exa key input only renders once Exa
 * is selected, so a settings-stored key already implies an explicit choice; the branch that actually
 * fires here is an operator's EXA_API_KEY, which is itself an explicit act. Platform costs the user
 * nothing beyond the login they already have, so it leads.
 */
export function resolveDefaultWebVendor(): WebProviderId {
  for (const id of DEFAULT_VENDOR_PRIORITY) {
    if (WEB_PROVIDERS[id].getApiKeyStatus().isConfigured) return id
  }
  return 'native'
}

/**
 * The vendor that will actually serve web calls right now — the single source of truth for both the
 * runtime (getActiveWebProvider) and the settings response's `effectiveWebProvider`, so the UI can
 * never claim a vendor the agent isn't using.
 *
 * A stored id is a PREFERENCE, not a contract: "use Exa when Exa is usable", not "fail if it isn't".
 * A pin whose credential has since disappeared (key deleted, signed out of Gamut) therefore behaves
 * exactly like no pin and falls through to the automatic default, rather than handing the agent a
 * vendor that can only throw. Nothing is persisted, so this heals in both directions — restore the
 * credential and the pin takes effect again on the next call.
 *
 * 'native' is the one id that needs no credential, so an explicit native choice always stands.
 */
export function resolveEffectiveWebVendor(): WebProviderId {
  const stored = getSettings().webProvider
  if (stored === 'native') return 'native'
  if (stored && isVendorId(stored) && WEB_PROVIDERS[stored].getApiKeyStatus().isConfigured) {
    return stored
  }
  return resolveDefaultWebVendor()
}

/**
 * The active host-side web provider, or null when the effective vendor is native (no host provider;
 * the container keeps the model's built-in web tools). Which operations it backs is a per-tool
 * question answered by the provider's optional search()/fetch() methods, not by a separate registry:
 * callers probe `provider.search` / `provider.fetch`.
 */
export function getActiveWebProvider(): BaseWebProvider | null {
  const id = resolveEffectiveWebVendor()
  return isVendorId(id) ? WEB_PROVIDERS[id] : null
}
