import { getTenantId } from './tenant-id'
import { getSettings, type AnalyticsTarget } from '../config/settings'
import { DEFAULT_AMPLITUDE_KEY } from './constants'

interface EventPayload {
  event_type: string
  user_id: string
  event_properties: Record<string, unknown>
  app_version?: string
  platform?: string
  os_name?: string
}

let appVersion: string | undefined

/** Set the app version (call once at startup from the build-time constant or package.json). */
export function setServerAnalyticsVersion(version: string) {
  appVersion = version
}

function getBaseProperties(): Record<string, unknown> {
  return {
    source: 'server',
    versionId: appVersion ?? 'unknown',
    platform: 'server',
    tenantId: getTenantId(),
  }
}

/**
 * Send an event to Amplitude via their HTTP V2 API.
 * Non-blocking — fires and forgets.
 */
async function sendToAmplitude(apiKey: string, events: EventPayload[]) {
  try {
    const res = await fetch('https://api2.amplitude.com/2/httpapi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, events }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[Analytics] Amplitude responded ${res.status}: ${body}`)
    }
  } catch (err) {
    console.warn('[Analytics] Failed to send to Amplitude:', err)
  }
}

/**
 * Send an event to Mixpanel via their /track endpoint.
 */
async function sendToMixpanel(token: string, event: string, properties: Record<string, unknown>) {
  try {
    const payload = [{
      event,
      properties: {
        token,
        distinct_id: properties.user_id ?? getTenantId(),
        ...properties,
      },
    }]
    await fetch('https://api.mixpanel.com/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // Non-critical
  }
}

/**
 * Send an event to Google Analytics via the Measurement Protocol.
 */
async function sendToGA(measurementId: string, event: string, properties: Record<string, unknown>) {
  try {
    // GA4 Measurement Protocol requires an api_secret; skip if not configured
    // This is a placeholder — full GA4 server-side requires an API secret
    // which would need to be added to the AnalyticsTarget config
    void measurementId
    void event
    void properties
  } catch {
    // Non-critical
  }
}

function dispatchToTargets(targets: AnalyticsTarget[], event: string, properties: Record<string, unknown>, userId: string) {
  for (const target of targets) {
    if (!target.enabled) continue
    switch (target.type) {
      case 'amplitude':
        if (target.config.apiKey) {
          sendToAmplitude(target.config.apiKey, [{
            event_type: event,
            user_id: userId,
            event_properties: properties,
            app_version: appVersion,
            platform: 'server',
          }])
        }
        break
      case 'mixpanel':
        if (target.config.token) {
          sendToMixpanel(target.config.token, event, { ...properties, user_id: userId })
        }
        break
      case 'google-analytics':
        if (target.config.measurementId) {
          sendToGA(target.config.measurementId, event, properties)
        }
        break
    }
  }
}

/**
 * Track an analytics event from the server side.
 * Reads current settings to determine active targets.
 * userId defaults to tenantId for server-originated events.
 */
export function trackServerEvent(
  event: string,
  properties: Record<string, unknown> = {},
  userId?: string,
) {
  const settings = getSettings()
  const targets = settings.analyticsTargets ?? []
  const effectiveUserId = userId ?? getTenantId()

  const fullProperties = {
    ...getBaseProperties(),
    ...properties,
  }

  // Send to admin-configured analytics targets
  if (targets.length > 0) {
    dispatchToTargets(targets, event, fullProperties, effectiveUserId)
  }

  // Send to hardcoded Amplitude (Datawizz) only if shareAnalytics is enabled
  if (DEFAULT_AMPLITUDE_KEY && settings.shareAnalytics) {
    sendToAmplitude(DEFAULT_AMPLITUDE_KEY, [{
      event_type: event,
      user_id: effectiveUserId,
      event_properties: fullProperties,
      app_version: appVersion,
      platform: 'server',
    }])
  }
}
