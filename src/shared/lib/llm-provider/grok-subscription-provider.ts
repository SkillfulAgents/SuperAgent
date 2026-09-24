import { parseGrokUsage } from './usage-schema'
import type { EffortLevel } from '../container/types'
import { GROK_DEFAULT_MODELS } from './model-catalog-defaults'
export { GROK_DEFAULT_MODELS } from './model-catalog-defaults'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { BaseLlmProvider } from './base-llm-provider'
import { PLATFORM_CATALOG } from './builtin-catalogs'
import { normalizeGrokMessages } from '../../../../agent-container/src/llm-proxy-grok'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { inferErrorStatus, extractErrorMessage } from './error-presentation'

export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com'
export const GROK_CLIENT_HEADERS = { 'x-grok-client-mode': 'cli', 'x-grok-client-version': '1.0.4' }

export class GrokSubscriptionLlmProvider extends BaseLlmProvider {
  readonly id = 'grok-subscription' as const
  readonly name = 'Grok Subscription'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = GROK_DEFAULT_MODELS
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = ''
  override readonly toolSearchEnv = 'true' as const
  override readonly supportsModelSearch = true

  override getEffectiveApiKey() { return this.configuration?.oauth?.accessToken }
  override getApiKeyStatus() {
    return this.getEffectiveApiKey() ? { isConfigured: true, source: 'settings' as const } : { isConfigured: false, source: 'none' as const }
  }
  private async credential(rejectedGeneration?: number) {
    if (!this.configuration?.resolveCredential) throw new Error('Reconnect Grok in Settings → Model Providers')
    return this.configuration.resolveCredential(rejectedGeneration)
  }
  getBuiltinCatalog() {
    return PLATFORM_CATALOG.filter(model => model.family === 'grok').map(model => ({
      ...model, supportedSpeeds: undefined, blurb: 'Uses your Grok subscription', supportsWebSearch: true,
    }))
  }
  async getContainerEnvVars() { return {} }
  override async getContainerProxyConfig(): Promise<LlmProxyConfig> {
    const { accessToken, expiresAt, generation, accountId } = await this.credential()
    return { adapter: 'grok', format: 'messages', baseUrl: `${GROK_SUBSCRIPTION_BASE_URL}/v1`,
      headers: GROK_CLIENT_HEADERS, credential: { accessToken, expiresAt, generation, accountId }, maxOutputTokens: 32768 }
  }
  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    let credential = await this.credential()
    const send = () => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${credential.accessToken}`)
      headers.delete('x-api-key')
      for (const [key, value] of Object.entries(GROK_CLIENT_HEADERS)) headers.set(key, value)
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
    return new Anthropic({ apiKey: '', authToken: 'app-managed', baseURL: GROK_SUBSCRIPTION_BASE_URL,
      fetch: async (input, init) => {
        let body: Record<string, unknown> | undefined
        if (typeof init?.body === 'string') {
          try { body = z.record(z.string(), z.unknown()).parse(JSON.parse(init.body)) }
          catch { throw new Error('Invalid Messages request') }
        }
        return this.fetch(input, { ...init, ...(body ? { body: JSON.stringify(normalizeGrokMessages(body)) } : {}) })
      },
    })
  }
  override readonly supportsUsage = true

  override async getUsage() {
    // Optional usage reporting must never drive OAuth refresh or block sessions.
    const accessToken = this.configuration?.oauth?.accessToken
    if (!accessToken) throw new Error('Grok usage credentials unavailable')
    const response = await fetch(`${GROK_SUBSCRIPTION_BASE_URL}/v1/billing?format=credits`, {
      headers: { ...GROK_CLIENT_HEADERS, authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Could not load Grok usage') }
    return parseGrokUsage(await response.json())
  }
  async validateKey() {
    try { await this.searchModels(''); return { valid: true } }
    catch { return { valid: false, error: 'Reconnect Grok in Settings → Model Providers' } }
  }
  override async searchModels(query: string) {
    const response = await this.fetch(`${GROK_SUBSCRIPTION_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Grok model discovery failed (${response.status})`)
    const schema = z.object({ data: z.array(z.object({ id: z.string(), name: z.string().optional(), context_window: z.number().optional() })) })
    const body = schema.parse(await response.json())
    return body.data.filter(model => model.id.toLowerCase().includes(query.toLowerCase())).map(model => ({
      id: model.id, label: model.name ?? model.id, contextWindow: model.context_window,
      supportedEfforts: ['low', 'medium', 'high'] as EffortLevel[], supportsWebSearch: true,
    }))
  }
  protected override parseErrorResponseOverride(status: number | undefined, body: unknown) {
    const actual = status ?? inferErrorStatus(extractErrorMessage(body))
    if (actual === 401) return { severity: 'error' as const, icon: 'info' as const, message: '**Grok sign-in expired or invalid.** Reconnect in Settings → Model Providers.' }
    if (actual === 402 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: '**Grok subscription access was denied.** Check the connected account’s subscription and entitlement.' }
    return null
  }
}
