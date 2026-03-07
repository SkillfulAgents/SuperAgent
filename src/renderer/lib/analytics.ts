import Analytics, { type AnalyticsInstance } from 'analytics'
import amplitudePlugin from '@analytics/amplitude'
import googleAnalyticsPlugin from '@analytics/google-analytics'
import mixpanelPlugin from '@analytics/mixpanel'
import type { AnalyticsTarget } from '@shared/lib/config/settings'
import { isElectron } from './env'

function buildPlugins(shareAnalytics: boolean, targets?: AnalyticsTarget[]) {
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
            plugins.push(amplitudePlugin({
              apiKey: target.config.apiKey,
              // Namespace to avoid collision with the Datawizz instance
              ...(shareAnalytics && __AMPLITUDE_API_KEY__ ? { pluginName: 'amplitude-custom' } : {}),
            }))
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

  return plugins
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
  if (shareAnalytics && __AMPLITUDE_API_KEY__) return true
  if (targets?.some(t => t.enabled)) return true
  return false
}
