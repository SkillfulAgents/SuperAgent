import { registerAccountProvider } from './provider-factory'
import { ComposioAccountProvider } from './composio-account-provider'
import { NangoAccountProvider } from './nango-account-provider'
import { getNangoSecretKey } from '@shared/lib/config/settings'

export function registerAllAccountProviders(): void {
  registerAccountProvider(new ComposioAccountProvider())

  const nangoKey = getNangoSecretKey()
  if (nangoKey) {
    registerAccountProvider(new NangoAccountProvider({ secretKey: nangoKey }))
  }
}
