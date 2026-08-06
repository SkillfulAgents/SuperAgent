import { getSettings, type ApiKeyStatus } from '@shared/lib/config/settings'

const SETTINGS_KEY = 'replicateApiKey' as const
const ENV_VAR = 'REPLICATE_API_TOKEN'
const ACCOUNT_URL = 'https://api.replicate.com/v1/account'
const REQUEST_TIMEOUT_MS = 10_000

export function getReplicateKeyStatus(): ApiKeyStatus {
  const settings = getSettings()
  if (settings.apiKeys?.[SETTINGS_KEY]) {
    return { isConfigured: true, source: 'settings' }
  }
  if (process.env[ENV_VAR]) {
    return { isConfigured: true, source: 'env' }
  }
  return { isConfigured: false, source: 'none' }
}

export function getEffectiveReplicateKey(): string | undefined {
  const settings = getSettings()
  const fromSettings = settings.apiKeys?.[SETTINGS_KEY]
  if (fromSettings) return fromSettings
  return process.env[ENV_VAR]
}

export async function validateReplicateKey(
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch(ACCOUNT_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.ok) return { valid: true }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: 'Invalid API key' }
    }
    return { valid: false, error: `Replicate API error: ${res.status}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return { valid: false, error: `Network error: ${message}` }
  }
}
