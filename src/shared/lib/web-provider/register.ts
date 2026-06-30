import { ExaWebSearchProvider } from './exa-web-search-provider'
import { FirecrawlWebSearchProvider } from './firecrawl-web-search-provider'
import { ParallelWebSearchProvider } from './parallel-web-search-provider'
import { clearWebSearchProviders, registerWebSearchProvider } from './search-factory'
import { YouComWebSearchProvider } from './youcom-web-search-provider'

/**
 * Construct and register the host-side web providers. Invoked once at startup.
 * Each constructor takes no key (the key is resolved per call), so they register
 * unconditionally; an unconfigured-but-selected vendor surfaces a clear error at
 * call time rather than silently degrading to native.
 */
export function registerAllWebProviders(): void {
  clearWebSearchProviders()
  registerWebSearchProvider(new ExaWebSearchProvider())
  registerWebSearchProvider(new ParallelWebSearchProvider())
  registerWebSearchProvider(new YouComWebSearchProvider())
  registerWebSearchProvider(new FirecrawlWebSearchProvider())
}
