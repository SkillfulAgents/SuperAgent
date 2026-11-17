import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import { BaseLlmProvider } from './base-llm-provider'
import { CLOUDFLARE_DEFAULT_MODELS } from './model-catalog-defaults'
import type { ModelDefinition, ModelSearchResult } from './model-catalog-schema'
import { translatedMessagesFetch } from './translated-messages-fetch'
import { extractErrorMessage, inferErrorStatus } from './error-presentation'
import type { EffortLevel } from '../container/types'

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 15_000
const SEARCH_LIMIT = 50
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high']

// Context windows from the Workers AI model search API (2026-11-16). All three return tool calls on Chat Completions.
const CLOUDFLARE_MODELS: ModelDefinition[] = ([
  { id: '@cf/zai-org/glm-5.3', label: 'GLM-5.3', family: 'glm', icon: 'zai', isLatest: true, isDefault: true, contextWindow: 1_048_576 },
  { id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash', family: 'deepseek', icon: 'deepseek', isLatest: true, isDefault: true, contextWindow: 1_048_576 },
  { id: '@cf/openai/gpt-oss-120b', label: 'gpt-oss-120b', family: 'gpt-oss', icon: 'openai', isLatest: true, isDefault: true, contextWindow: 128_000 },
] satisfies Omit<ModelDefinition, 'supportedEfforts'>[]).map(model => ({
  ...model, blurb: 'Runs on your Cloudflare Workers AI account', supportedEfforts: EFFORTS, supportsWebSearch: false,
}))

const modelSearchSchema = z.object({
  result: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    properties: z.array(z.object({ property_id: z.string(), value: z.unknown() })).default([]),
  })),
})

function searchResult(model: z.infer<typeof modelSearchSchema>['result'][number]): ModelSearchResult | null {
  const property = (id: string) => model.properties.find(entry => entry.property_id === id)?.value
  // Agents need tool calls; a model past its deprecation date no longer serves requests.
  if (String(property('function_calling')) !== 'true') return null
  const deprecation = property('planned_deprecation_date')
  if (typeof deprecation === 'string' && Date.parse(deprecation) <= Date.now()) return null
  const slug = model.name.split('/').pop() ?? model.name
  const contextWindow = Number(property('context_window'))
  const prices = z.array(z.object({ unit: z.string(), price: z.number() })).safeParse(property('price'))
  const price = (unit: string) => prices.success ? prices.data.find(entry => entry.unit === unit)?.price : undefined
  const inputPerMtok = price('per M input tokens')
  const outputPerMtok = price('per M output tokens')
  return {
    id: model.name,
    label: slug,
    blurb: model.description,
    family: slug.split(/[-.]/)[0]?.toLowerCase() || undefined,
    supportedEfforts: EFFORTS,
    supportsWebSearch: false,
    supportsImageInput: String(property('vision')) === 'true',
    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(inputPerMtok !== undefined && outputPerMtok !== undefined ? { pricing: { inputPerMtok, outputPerMtok } } : {}),
  }
}

/** Workers AI with the user's own API token, through its OpenAI Chat Completions endpoint. */
export class CloudflareLlmProvider extends BaseLlmProvider {
  readonly id = 'cloudflare' as const
  readonly name = 'Cloudflare Workers AI'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = CLOUDFLARE_DEFAULT_MODELS
  override readonly supportsModelSearch = true
  protected readonly settingsKeyField = 'cloudflareApiToken' as const
  protected readonly envVarName = ''

  // The translation rebuilds every tool, so deferred tools never reach Workers AI.
  override async toolSearchEnv() { return 'true' as const }
  // Credentials come only from the connection, never from global settings.
  protected override async ambientSettings() { return undefined }
  getBuiltinCatalog() { return CLOUDFLARE_MODELS }

  private accountUrl(): string {
    const accountId = this.configuration?.apiKeys.cloudflareAccountId?.trim()
    if (!accountId) throw new Error('Cloudflare account ID not configured')
    return `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}`
  }

  private token(apiKey?: string): string {
    const token = apiKey || this.effectiveApiKeyFrom(undefined)
    if (!token) throw new Error('Cloudflare API token not configured')
    return token
  }

  override apiKeyStatusFrom() {
    return this.effectiveApiKeyFrom(undefined) && this.configuration?.apiKeys.cloudflareAccountId?.trim()
      ? { isConfigured: true, source: 'settings' as const }
      : { isConfigured: false, source: 'none' as const }
  }

  async createClientFrom(): Promise<Anthropic> {
    const token = this.token()
    return new Anthropic({ baseURL: CLOUDFLARE_API, authToken: token,
      fetch: translatedMessagesFetch(`${this.accountUrl()}/ai/v1`, token, 'chat-completions') })
  }

  override async getContainerProxyConfig(): Promise<LlmProxyConfig> {
    return { format: 'chat-completions', baseUrl: `${this.accountUrl()}/ai/v1`, credential: { accessToken: this.token(), generation: 0 },
      headers: {}, chatTokenLimitField: 'max_completion_tokens' }
  }

  async getContainerEnvVars() { return {} }

  private async listModels(query: string, apiKey?: string, perPage = 100): Promise<Response> {
    const url = new URL(`${this.accountUrl()}/ai/models/search`)
    url.searchParams.set('task', 'Text Generation')
    url.searchParams.set('per_page', String(perPage))
    if (query.trim()) url.searchParams.set('search', query.trim())
    return fetch(url, { headers: { Authorization: `Bearer ${this.token(apiKey)}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' })
  }

  /** One models request checks the token and the account ID together. */
  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    let response: Response
    try {
      response = await this.listModels('', apiKey, 1)
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Could not reach Cloudflare' }
    }
    await response.body?.cancel()
    if (response.ok) return { valid: true }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { valid: false, error: `Cloudflare rejected the token or account ID (${response.status}). The token needs Workers AI Read and Edit permission on this account.` }
    }
    return { valid: false, error: `Cloudflare returned ${response.status}` }
  }

  override async searchModels(query: string): Promise<ModelSearchResult[]> {
    const response = await this.listModels(query)
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Cloudflare model search failed (${response.status})`)
    }
    const body = modelSearchSchema.parse(await response.json())
    return body.result.map(searchResult).filter((model): model is ModelSearchResult => model !== null).slice(0, SEARCH_LIMIT)
  }

  protected override async parseErrorResponseOverride(status: number | undefined, body: unknown) {
    const message = extractErrorMessage(body)
    const actual = status ?? inferErrorStatus(message)
    if (actual === 401 || actual === 403) return { severity: 'error' as const, icon: 'info' as const, message: '**Cloudflare rejected the API token.** Check the token and account ID in Settings → Model Providers.' }
    return null
  }
}
