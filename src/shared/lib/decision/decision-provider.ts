import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'
import { NonRetryableError, withRetry } from '../utils/retry'
import { DECISION_MODELS, type DecisionProviderId, type DecisionRequest, type DecisionResult } from './types'

export abstract class BaseDecisionProvider {
  abstract readonly id: DecisionProviderId
  abstract readonly name: string

  /** Which field in ApiKeySettings stores this provider's key. */
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
  /** Environment variable name for this provider's key. */
  protected abstract readonly envVarName: string

  protected abstract endpointUrl(model: string): string
  /** Cheap authenticated GET used to check a key before saving it. */
  protected abstract keyCheckUrl(): string
  protected abstract encode(request: DecisionRequest, model: string): unknown
  protected abstract decode(body: unknown): DecisionResult

  /** Check whether an API key is configured and its source. */
  getApiKeyStatus(): ApiKeyStatus {
    if (getSettings().apiKeys?.[this.settingsKeyField]) return { isConfigured: true, source: 'settings' }
    if (process.env[this.envVarName]) return { isConfigured: true, source: 'env' }
    return { isConfigured: false, source: 'none' }
  }

  /** Get the effective API key (settings take precedence over env var). */
  getEffectiveApiKey(): string | undefined {
    return getSettings().apiKeys?.[this.settingsKeyField] || process.env[this.envVarName]
  }

  get defaultModel(): string {
    return DECISION_MODELS[this.id][0]
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(this.keyCheckUrl(), { headers: { Authorization: `Bearer ${apiKey}` } })
      return res.ok ? { valid: true } : { valid: false, error: `${this.name} rejected the key (${res.status})` }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Validation failed' }
    }
  }

  /** Ask every question in one call. Throws if any question comes back unanswered. */
  async decide(request: DecisionRequest, model = this.defaultModel): Promise<DecisionResult> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error(`No API key configured for ${this.name}.`)
    const url = this.endpointUrl(model)
    const body = JSON.stringify(this.encode(request, model))
    const response = await withRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
      })
      if (res.ok) return res
      const message = `${this.name} decision request failed (${res.status}): ${(await res.text()).slice(0, 500)}`
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new NonRetryableError(message, res.status)
      throw new Error(message)
    })
    const result = this.decode(await response.json())
    const missing = Object.keys(request.questions).filter(name => !(name in result))
    if (missing.length > 0) throw new Error(`${this.name} decision response is missing answers for: ${missing.join(', ')}`)
    return result
  }
}
