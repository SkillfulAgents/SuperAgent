import { parseMinimaxUsage } from './usage-schema'
import type { EffortLevel } from '../container/types'
import { MINIMAX_DEFAULT_MODELS } from './model-catalog-defaults'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { BaseLlmProvider } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { MINIMAX_HEADERS, MINIMAX_HOSTS, minimaxRegion } from './minimax-oauth'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { inferErrorStatus, extractErrorMessage } from './error-presentation'

// The Messages API does not advertise effort tiers. One level satisfies the catalog.
const MINIMAX_EFFORTS: EffortLevel[] = ['high']
// M3's documented context is 1M (MiniMax's Claude Code guide sets the compact window there).
const MINIMAX_MODELS: ModelDefinition[] = [
  { id: 'MiniMax-M3', label: 'MiniMax M3', contextWindow: 1_000_000, supportsImageInput: true, isLatest: true, isDefault: true },
].map(model => ({
  ...model, family: 'minimax', icon: 'minimax', blurb: 'Uses your MiniMax Token Plan', supportedEfforts: MINIMAX_EFFORTS, supportsWebSearch: false,
}))
// Text models from the public Messages API. M2 does not accept image input.
const MINIMAX_SEARCH_MODELS: ModelDefinition[] = [
  ...MINIMAX_MODELS,
  ...['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2']
    .map(id => ({ id, label: id.replace('MiniMax-', 'MiniMax '), family: 'minimax', icon: 'minimax', supportedEfforts: MINIMAX_EFFORTS, supportsWebSearch: false, supportsImageInput: false })),
]

export class MinimaxSubscriptionLlmProvider extends BaseLlmProvider {
  readonly id = 'minimax-subscription' as const
  readonly name = 'MiniMax Subscription'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = MINIMAX_DEFAULT_MODELS
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = ''
  override readonly toolSearchEnv = 'true' as const
  override readonly supportsModelSearch = true
  override readonly supportsUsage = true

  override getEffectiveApiKey() { return this.configuration?.oauth?.accessToken }
  override getApiKeyStatus() {
    return this.getEffectiveApiKey() ? { isConfigured: true, source: 'settings' as const } : { isConfigured: false, source: 'none' as const }
  }
  private get apiBase() { return MINIMAX_HOSTS[minimaxRegion(this.configuration?.oauth?.region)].api }
  private async credential(rejectedGeneration?: number) {
    if (!this.configuration?.resolveCredential) throw new Error('Reconnect MiniMax in Settings → Model Providers')
    return this.configuration.resolveCredential(rejectedGeneration)
  }
  getBuiltinCatalog() { return MINIMAX_MODELS }
  async getContainerEnvVars() { return {} }
  override async getContainerProxyConfig(): Promise<LlmProxyConfig> {
    const { accessToken, expiresAt, generation, accountId } = await this.credential()
    return {
      format: 'messages', baseUrl: `${this.apiBase}/anthropic/v1`,
      // The published container only accepts grok/codex/kimi adapters and always adds Authorization.
      // It forwards this header as-is; MiniMax reads the token from x-api-key.
      headers: { ...MINIMAX_HEADERS, 'x-api-key': accessToken },
      credential: { accessToken, expiresAt, generation, accountId },
    }
  }
  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let credential = await this.credential()
    const send = () => {
      const headers = new Headers(init?.headers)
      // The Messages endpoint rejects Authorization and requires this header.
      headers.set('x-api-key', credential.accessToken)
      headers.delete('authorization')
      for (const [key, value] of Object.entries(MINIMAX_HEADERS)) headers.set(key, value)
      return fetch(input, { ...init, headers, redirect: 'error' })
    }
    let response = await send()
    if (response.status === 401) {
      await response.body?.cancel()
      credential = await this.credential(credential.generation)
      response = await send()
    }
    return response
  }
  createClient(): Anthropic {
    return new Anthropic({ apiKey: '', authToken: 'app-managed', baseURL: `${this.apiBase}/anthropic`, fetch: (input, init) => this.fetch(input, init) })
  }
  private async allowance(accessToken: string) {
    const response = await fetch(`${this.apiBase}/v1/token_plan/remains`, {
      headers: { ...MINIMAX_HEADERS, authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000), redirect: 'error',
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Could not load MiniMax usage') }
    const body: unknown = await response.json()
    const status = z.object({ base_resp: z.object({ status_code: z.number() }).optional() }).parse(body).base_resp?.status_code
    if (status) throw new Error('Could not load MiniMax usage')
    return body
  }
  override async getUsage() {
    const accessToken = this.configuration?.oauth?.accessToken
    if (!accessToken) throw new Error('MiniMax usage credentials unavailable')
    return parseMinimaxUsage(await this.allowance(accessToken))
  }
  async validateKey() {
    try { await this.allowance(await this.credential().then(credential => credential.accessToken)); return { valid: true } }
    catch { return { valid: false, error: 'Reconnect MiniMax in Settings → Model Providers' } }
  }
  override async searchModels(query: string) {
    const needle = query.toLowerCase()
    return MINIMAX_SEARCH_MODELS.filter(model => model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle))
  }
  protected override parseErrorResponseOverride(status: number | undefined, body: unknown) {
    const actual = status ?? inferErrorStatus(extractErrorMessage(body))
    if (actual === 401) return { severity: 'error' as const, icon: 'info' as const, message: '**MiniMax sign-in expired or invalid.** Reconnect in Settings → Model Providers.' }
    if (actual === 402 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: '**MiniMax subscription access was denied.** Check the connected account’s Token Plan.' }
    return null
  }
}
