import { parseKimiUsage } from './usage-schema'
import type { EffortLevel } from '../container/types'
import { KIMI_DEFAULT_MODELS } from './model-catalog-defaults'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { BaseLlmProvider } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { pricingFor } from './model-pricing-lookup'
import { KIMI_HEADERS, KIMI_HOSTS, kimiRegion } from './kimi-oauth'
import { isKimiPlanLimit, KIMI_PLAN_LIMIT } from '../../../../agent-container/src/llm-proxy-kimi'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { inferErrorStatus, extractErrorMessage } from './error-presentation'

// Effort tiers advertised by the subscription's /models (live verified).
const KIMI_EFFORTS: EffortLevel[] = ['low', 'high', 'max']
// Fixed at 256K: plans below the 1M tier reject larger K3 contexts, so compaction must start before that.
const KIMI_MODELS: ModelDefinition[] = [
  { id: 'k3', label: 'Kimi K3', isLatest: true, isDefault: true },
].map(model => ({
  ...model, family: 'kimi', icon: 'kimi', blurb: 'Uses your Kimi Code subscription', supportedEfforts: KIMI_EFFORTS,
  supportsWebSearch: false, supportsImageInput: true, contextWindow: 262_144, pricing: pricingFor('kimi-k3'),
}))

export class KimiSubscriptionLlmProvider extends BaseLlmProvider {
  readonly id = 'kimi-subscription' as const
  readonly name = 'Kimi Subscription'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = KIMI_DEFAULT_MODELS
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = ''
  override readonly toolSearchEnv = 'true' as const
  override readonly supportsModelSearch = true
  override readonly supportsUsage = true

  override getEffectiveApiKey() { return this.configuration?.oauth?.accessToken }
  override getApiKeyStatus() {
    return this.getEffectiveApiKey() ? { isConfigured: true, source: 'settings' as const } : { isConfigured: false, source: 'none' as const }
  }
  private get apiBase() { return KIMI_HOSTS[kimiRegion(this.configuration?.oauth?.region)].api }
  private async credential(rejectedGeneration?: number) {
    if (!this.configuration?.resolveCredential) throw new Error('Reconnect Kimi in Settings → Model Providers')
    return this.configuration.resolveCredential(rejectedGeneration)
  }
  getBuiltinCatalog() { return KIMI_MODELS }
  async getContainerEnvVars() { return {} }
  override async getContainerProxyConfig(): Promise<LlmProxyConfig> {
    const { accessToken, expiresAt, generation, accountId } = await this.credential()
    return { adapter: 'kimi', format: 'messages', baseUrl: `${this.apiBase}/v1`, headers: KIMI_HEADERS,
      credential: { accessToken, expiresAt, generation, accountId } }
  }
  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let credential = await this.credential()
    const send = () => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${credential.accessToken}`)
      headers.delete('x-api-key')
      for (const [key, value] of Object.entries(KIMI_HEADERS)) headers.set(key, value)
      return fetch(input, { ...init, headers, redirect: 'error' })
    }
    let response = await send()
    if (response.status === 401 && !isKimiPlanLimit(await response.clone().json().catch(() => null))) {
      await response.body?.cancel()
      credential = await this.credential(credential.generation)
      response = await send()
    }
    return response
  }
  createClient(): Anthropic {
    return new Anthropic({ apiKey: '', authToken: 'app-managed', baseURL: this.apiBase, fetch: (input, init) => this.fetch(input, init) })
  }
  override async getUsage() {
    // Optional usage reporting must never drive OAuth refresh or block sessions.
    const accessToken = this.configuration?.oauth?.accessToken
    if (!accessToken) throw new Error('Kimi usage credentials unavailable')
    const response = await fetch(`${this.apiBase}/v1/usages`, {
      headers: { ...KIMI_HEADERS, authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Could not load Kimi usage') }
    return parseKimiUsage(await response.json())
  }
  async validateKey() {
    try { await this.searchModels(''); return { valid: true } }
    catch { return { valid: false, error: 'Reconnect Kimi in Settings → Model Providers' } }
  }
  override async searchModels(query: string) {
    const response = await this.fetch(`${this.apiBase}/v1/models`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Kimi model discovery failed (${response.status})`)
    const schema = z.object({ data: z.array(z.object({
      id: z.string(), display_name: z.string().optional(), context_length: z.number().optional(), supports_image_in: z.boolean().optional(),
      think_efforts: z.object({ valid_efforts: z.array(z.string()).optional() }).optional(),
    })) })
    const body = schema.parse(await response.json())
    return body.data.filter(model => model.id.toLowerCase().includes(query.toLowerCase())).map(model => ({
      id: model.id, label: model.display_name ?? model.id, contextWindow: model.context_length, supportsImageInput: model.supports_image_in,
      supportedEfforts: KIMI_EFFORTS.filter(effort => model.think_efforts?.valid_efforts?.includes(effort)), supportsWebSearch: false,
    }))
  }
  protected override parseErrorResponseOverride(status: number | undefined, body: unknown) {
    const actual = status ?? inferErrorStatus(extractErrorMessage(body))
    const message = extractErrorMessage(body)
    if (KIMI_PLAN_LIMIT.test(message)) return { severity: 'error' as const, icon: 'info' as const, message: `**Your Kimi plan does not include this request.** ${message}` }
    if (actual === 401) return { severity: 'error' as const, icon: 'info' as const, message: '**Kimi sign-in expired or invalid.** Reconnect in Settings → Model Providers.' }
    if (actual === 402 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: '**Kimi subscription access was denied.** Check the connected account’s membership.' }
    return null
  }
}
