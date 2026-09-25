import { parseCodexUsage } from './usage-schema'
import { CODEX_DEFAULT_MODELS } from './model-catalog-defaults'
export { CODEX_DEFAULT_MODELS } from './model-catalog-defaults'
import type { EffortLevel, SpeedLevel } from '../container/types'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { BaseLlmProvider } from './base-llm-provider'
import { PLATFORM_CATALOG } from './builtin-catalogs'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { inferErrorStatus, extractErrorMessage } from './error-presentation'

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CODEX_CLIENT_VERSION = '0.156.1'
export const CODEX_HEADERS = { originator: 'codex_cli_rs', 'OpenAI-Beta': 'responses=experimental' }
const CODEX_IMAGE_PROMPT = `Codex image generation is available in this session through the connected ChatGPT subscription; it uses that subscription's Codex allowance. There is no dedicated tool: write a Bash script (Node or Python) that follows these steps. Never print tokens, credentials, base64 or full responses.
1. Credential: POST process.env.SUPERAGENT_HOST_API_URL (remove its trailing slash) + "/llm-runtime/resolve" with Authorization: Bearer <process.env.PROXY_TOKEN>, Content-Type: application/json and body {"sessionId": <process.env.GAMUT_SESSION_ID>}. Use proxy.credential.accessToken, proxy.credential.accountId and proxy.credential.generation from the response.
2. Generate: POST ${CODEX_BASE_URL}/images/generations with headers Authorization: Bearer <accessToken>, ChatGPT-Account-ID: <accountId>, ${Object.entries(CODEX_HEADERS).map(([name, value]) => `${name}: ${value}`).join(', ')}, Content-Type: application/json. Body: {"model":"gpt-image-2","prompt":"A red square on a white background","size":"auto","quality":"auto","background":"opaque"}; use "background":"transparent" for a transparent image. To edit or use reference images, POST the same body plus "images":[{"image_url":"data:image/png;base64,..."}] to ${CODEX_BASE_URL}/images/edits, with up to 5 PNG, JPEG or WebP data URLs encoded from local files. Allow up to 5 minutes.
3. If the image request returns 401, resolve again with {"sessionId": ..., "rejectedGeneration": <generation>} and retry once. Do not retry after a timeout or network failure: the first request may already have used allowance. For other errors, report the provider's error message.
4. The response is {"data":[{"b64_json":"..."}]}. Decode each image, save it under /workspace/media/ with a unique filename and an extension matching its bytes, print only the saved paths, and deliver them with the existing file-delivery tool. Reuse saved files instead of regenerating.`
// Subscription speed choices exclude the API-only Flex tier.
const CODEX_SPEEDS: SpeedLevel[] = ['normal', 'fast']
// Subscription model availability/context differs from the public API catalog.
const CODEX_MODELS = new Set(['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'])

export class CodexSubscriptionLlmProvider extends BaseLlmProvider {
  readonly id = 'codex-subscription' as const
  readonly name = 'Codex Subscription'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = CODEX_DEFAULT_MODELS
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = ''
  override readonly toolSearchEnv = 'true' as const
  override readonly mediaPrompt = CODEX_IMAGE_PROMPT
  override readonly supportsModelSearch = true
  // This integration exposes the subscription through the agent proxy, not a
  // host API client. Existing helper selection supplies a global API provider.
  override readonly supportsDirectApi = false
  override getEffectiveApiKey() { return this.configuration?.oauth?.accessToken }
  override getApiKeyStatus() {
    return this.getEffectiveApiKey() ? { isConfigured: true, source: 'settings' as const } : { isConfigured: false, source: 'none' as const }
  }
  private async credential(rejectedGeneration?: number) {
    if (!this.configuration?.resolveCredential) throw new Error('Reconnect Codex in Settings → Model Providers')
    return this.configuration.resolveCredential(rejectedGeneration)
  }
  getBuiltinCatalog() {
    return PLATFORM_CATALOG.filter(model => CODEX_MODELS.has(model.id)).map(model => ({
      ...model, supportedSpeeds: CODEX_SPEEDS, contextWindow: 272000,
      longContextPriceCliff: undefined, blurb: 'Uses your ChatGPT subscription', supportsWebSearch: true,
    }))
  }
  createClient(): Anthropic {
    throw new Error('Codex Subscription supports agent sessions only. Choose an API-capable global summarizer in Settings → Model Providers.')
  }
  async getContainerEnvVars() { return {} }
  override async getContainerProxyConfig(): Promise<LlmProxyConfig> {
    const { accessToken, expiresAt, generation, accountId } = await this.credential()
    if (!accountId) throw new Error('Reconnect Codex to select a subscription account')
    return { adapter: 'codex', format: 'responses', baseUrl: CODEX_BASE_URL,
      headers: CODEX_HEADERS, credential: { accessToken, expiresAt, generation, accountId } }
  }
  override readonly supportsUsage = true

  override async getUsage() {
    // Allowance reads must not acquire a refresh lease or mutate failure state.
    const credential = this.configuration?.oauth
    if (!credential?.accessToken || !credential.accountId) throw new Error('Codex usage credentials unavailable')
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { ...CODEX_HEADERS, authorization: `Bearer ${credential.accessToken}`, 'ChatGPT-Account-ID': credential.accountId },
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Could not load Codex usage') }
    return parseCodexUsage(await response.json())
  }
  async validateKey() {
    try { await this.searchModels(''); return { valid: true } }
    catch { return { valid: false, error: 'Reconnect Codex in Settings → Model Providers' } }
  }
  override async searchModels(query: string) {
    let credential = await this.credential()
    const send = () => fetch(`${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: { ...CODEX_HEADERS, authorization: `Bearer ${credential.accessToken}`, 'ChatGPT-Account-ID': credential.accountId ?? '' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    })
    let response = await send()
    if (response.status === 401) { await response.body?.cancel(); credential = await this.credential(credential.generation); response = await send() }
    if (!response.ok) throw new Error(`Codex model discovery failed (${response.status})`)
    const schema = z.object({ models: z.array(z.object({ slug: z.string(), display_name: z.string().optional(), context_window: z.number().optional(), visibility: z.string(), additional_speed_tiers: z.array(z.string()).optional(), service_tiers: z.array(z.object({ id: z.string() })).optional(), supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional() })) })
    return schema.parse(await response.json()).models.filter(model => model.visibility === 'list' && model.slug.toLowerCase().includes(query.toLowerCase())).map(model => ({
      id: model.slug, label: model.display_name ?? model.slug, contextWindow: model.context_window,
      supportedEfforts: (model.supported_reasoning_levels ?? []).flatMap<EffortLevel>(({ effort }) =>
        effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max' ? [effort] : []),
      supportedSpeeds: model.additional_speed_tiers?.includes('fast') || model.service_tiers?.some(tier => tier.id === 'priority' || tier.id === 'fast') ? CODEX_SPEEDS : undefined,
      supportsWebSearch: true,
    }))
  }
  protected override parseErrorResponseOverride(status: number | undefined, body: unknown, apiErrorCode?: string) {
    const actual = status ?? inferErrorStatus(extractErrorMessage(body))
    if (actual === 401 || apiErrorCode === 'authentication_failed') return { severity: 'error' as const, icon: 'info' as const, message: '**Codex sign-in expired or invalid.** Reconnect in Settings → Model Providers.' }
    if (actual === 402 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: '**Codex subscription access was denied.** Check the connected ChatGPT account’s Codex access.' }
    if (actual === 429) return { severity: 'warning' as const, icon: 'info' as const, message: '**Codex rate or subscription limit reached.** Retry later or select another provider.' }
    return null
  }
}
