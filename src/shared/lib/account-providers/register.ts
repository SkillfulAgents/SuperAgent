import { registerAccountProvider } from './provider-factory'
import { ComposioAccountProvider } from './composio-account-provider'
import { NangoAccountProvider } from './nango-account-provider'

/**
 * Register every account provider. Nango is registered whether or not a
 * secret key is saved: it reads the key from settings on each use, and the
 * factory leaves it out of the default and of the configured list while
 * there is none (see `BaseAccountProvider.isConfigured`). So a key saved,
 * changed or removed by any process takes effect on the next use, with no
 * re-registration. Calling this again replaces the instances.
 */
export function registerAllAccountProviders(): void {
  registerAccountProvider(new ComposioAccountProvider())
  registerAccountProvider(new NangoAccountProvider())
}
