import { getSettings } from '@shared/lib/config/settings'
import { ChromeProvider } from './chrome-provider'
import { BrowserbaseProvider } from './browserbase-provider'
import { PlatformBrowserProvider } from './platform-provider'
import { SteelProvider } from './steel-provider'
import { TabtenderProvider } from './tabtender-provider'
import type { HostBrowserProvider, HostBrowserProviderStatus } from './types'

export type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo } from './types'
export type { HostBrowserProviderId } from './types'

// Singleton instances
const chromeProvider = new ChromeProvider()
const browserbaseProvider = new BrowserbaseProvider()
const platformBrowserProvider = new PlatformBrowserProvider()
const steelProvider = new SteelProvider()
const tabtenderProvider = new TabtenderProvider()

const providerMap: Record<string, HostBrowserProvider> = {
  chrome: chromeProvider,
  browserbase: browserbaseProvider,
  platform: platformBrowserProvider,
  steel: steelProvider,
  tabtender: tabtenderProvider,
}

/**
 * Get the active host browser provider based on settings.
 * Returns null when in "Container (built-in)" mode (no host browser provider selected).
 */
export async function getActiveProvider(): Promise<HostBrowserProvider | null> {
  const settings = await getSettings()
  const providerId = settings.app?.hostBrowserProvider
  if (!providerId) return null
  return providerMap[providerId] ?? null
}

/**
 * Detect availability of all host browser providers.
 * Used by the settings API to populate the provider dropdown.
 */
export async function detectAllProviders(): Promise<HostBrowserProviderStatus[]> {
  return Promise.all([
    chromeProvider.detect(),
    browserbaseProvider.detect(),
    platformBrowserProvider.detect(),
    steelProvider.detect(),
    tabtenderProvider.detect(),
  ])
}

/**
 * Stop one instance's browser on EVERY provider, not just the currently
 * selected one. The active provider setting can change while a browser is
 * running (e.g. Chrome launched, then the user switches to Browserbase), so
 * teardown keyed to getActiveProvider() would miss it. Used by agent deletion
 * before the profile directory is removed.
 */
export async function stopInstanceOnAllProviders(instanceId: string): Promise<void> {
  await Promise.all(
    Object.values(providerMap).map(async (provider) => {
      if (provider.isRunning(instanceId)) {
        await provider.stop(instanceId)
      }
    })
  )
}

/**
 * Stop all provider instances. Used during graceful shutdown.
 */
export async function stopAllProviders(): Promise<void> {
  await Promise.all([
    chromeProvider.stopAll(),
    browserbaseProvider.stopAll(),
    platformBrowserProvider.stopAll(),
    steelProvider.stopAll(),
    tabtenderProvider.stopAll(),
  ])
}

/**
 * Wire up the onExternalClose callback on all providers that support it.
 */
export function setOnExternalClose(callback: (instanceId: string) => void): void {
  chromeProvider.onExternalClose = callback
  // The cloud providers don't fire external close events, but wire up for consistency
  browserbaseProvider.onExternalClose = callback
  platformBrowserProvider.onExternalClose = callback
  steelProvider.onExternalClose = callback
  tabtenderProvider.onExternalClose = callback
}
