import { getSettings } from '@shared/lib/config/settings'
import { ChromeProvider } from './chrome-provider'
import { BrowserbaseProvider } from './browserbase-provider'
import { PlatformBrowserProvider } from './platform-provider'
import type { HostBrowserProvider, HostBrowserProviderStatus } from './types'

export type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo } from './types'
export type { HostBrowserProviderId } from './types'

// Singleton instances
const chromeProvider = new ChromeProvider()
const browserbaseProvider = new BrowserbaseProvider()
const platformBrowserProvider = new PlatformBrowserProvider()

const providerMap: Record<string, HostBrowserProvider> = {
  chrome: chromeProvider,
  browserbase: browserbaseProvider,
  platform: platformBrowserProvider,
}

/**
 * Get the active host browser provider based on settings.
 * Returns null when in "Container (built-in)" mode (no host browser provider selected).
 */
export function getActiveProvider(): HostBrowserProvider | null {
  const settings = getSettings()
  const providerId = settings.app?.hostBrowserProvider
  if (!providerId) return null
  return providerMap[providerId] ?? null
}

/**
 * Detect availability of all host browser providers.
 * Used by the settings API to populate the provider dropdown.
 */
export function detectAllProviders(): HostBrowserProviderStatus[] {
  return [chromeProvider.detect(), browserbaseProvider.detect(), platformBrowserProvider.detect()]
}

/**
 * Stop all provider instances. Used during graceful shutdown.
 */
export async function stopAllProviders(): Promise<void> {
  await Promise.all([
    chromeProvider.stopAll(),
    browserbaseProvider.stopAll(),
    platformBrowserProvider.stopAll(),
  ])
}

/**
 * Wire up the onExternalClose callback on all providers that support it.
 */
export function setOnExternalClose(callback: (instanceId: string) => void): void {
  chromeProvider.onExternalClose = callback
  // Browserbase / platform don't fire external close events, but wire up for consistency
  browserbaseProvider.onExternalClose = callback
  platformBrowserProvider.onExternalClose = callback
}
