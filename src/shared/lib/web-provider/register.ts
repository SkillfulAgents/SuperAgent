import { ExaWebSearchProvider } from './exa-web-search-provider'
import { clearWebSearchProviders, registerWebSearchProvider } from './search-factory'

/**
 * Construct and register the host-side web providers. Invoked once at startup.
 * Exa's constructor takes no key (the key is resolved per call), so it registers
 * unconditionally; an unconfigured-but-selected vendor surfaces a clear error at
 * call time rather than silently degrading to native.
 */
export function registerAllWebProviders(): void {
  clearWebSearchProviders()
  registerWebSearchProvider(new ExaWebSearchProvider())
}
