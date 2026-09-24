import Analytics, { type AnalyticsInstance } from 'analytics'
import amplitudePlugin from '@analytics/amplitude'
import googleAnalyticsPlugin from '@analytics/google-analytics'
import mixpanelPlugin from '@analytics/mixpanel'
import type { AnalyticsTarget } from '@shared/lib/config/settings'
import { isElectron } from './env'

function buildPlugins(shareAnalytics: boolean, targets?: AnalyticsTarget[]) {
  if (__E2E_MOCK__) return []

  const plugins: ReturnType<typeof amplitudePlugin>[] = []

  // Datawizz sharing via hardcoded Amplitude key
  if (shareAnalytics && __AMPLITUDE_API_KEY__) {
    plugins.push(amplitudePlugin({ apiKey: __AMPLITUDE_API_KEY__ }))
  }

  // Custom analytics targets (auth mode admin-configured)
  if (targets) {
    for (const target of targets) {
      if (!target.enabled) continue
      switch (target.type) {
        case 'amplitude':
          if (target.config.apiKey) {
            plugins.push(amplitudePlugin({ apiKey: target.config.apiKey }))
          }
          break
        case 'google-analytics':
          if (target.config.measurementId) {
            plugins.push(googleAnalyticsPlugin({ measurementIds: [target.config.measurementId] }))
          }
          break
        case 'mixpanel':
          if (target.config.token) {
            plugins.push(mixpanelPlugin({ token: target.config.token }))
          }
          break
      }
    }
  }

  return dedupeByName(plugins)
}

// Analytics() throws `<name>AlreadyLoaded` on a repeated plugin name, and these
// plugins drive one page-global SDK each, so a second copy could never load anyway.
function dedupeByName<T extends { name: string }>(plugins: T[]): T[] {
  const seen = new Set<string>()
  return plugins.filter((plugin) => {
    if (seen.has(plugin.name)) {
      console.warn(`[Analytics] Ignoring duplicate "${plugin.name}" target; only the first one is used.`)
      return false
    }
    seen.add(plugin.name)
    return true
  })
}

export function getAnalyticsMetadata() {
  const platform = isElectron() ? 'electron' : 'web'
  const metadata: Record<string, string> = {
    versionId: __APP_VERSION__,
    platform,
  }

  if (platform === 'electron') {
    metadata.os = navigator.platform
  } else {
    metadata.browser = navigator.userAgent
  }

  return metadata
}

export function createAnalyticsInstance(
  shareAnalytics: boolean,
  targets?: AnalyticsTarget[],
): AnalyticsInstance {
  const plugins = buildPlugins(shareAnalytics, targets)

  return Analytics({
    app: 'superagent',
    version: __APP_VERSION__,
    plugins,
  })
}

export function hasActivePlugins(shareAnalytics: boolean, targets?: AnalyticsTarget[]): boolean {
  if (__E2E_MOCK__) return false
  if (shareAnalytics && __AMPLITUDE_API_KEY__) return true
  if (targets?.some(t => t.enabled)) return true
  return false
}
