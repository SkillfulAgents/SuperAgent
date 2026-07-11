import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelPurpose } from './base-llm-provider'
import type { ModelDefinition, ModelSearchResult } from './model-catalog-schema'
import { OPENROUTER_CATALOG } from './builtin-catalogs'
import type { EffortLevel } from '../container/types'
import { GPT_TOOL_USE_PROMPT_HINTS } from './model-prompt-hints'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'
const DISCOVERED_MODEL_LIMIT = 25
const DISCOVERED_MODEL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high']

interface OpenRouterModelListing {
  architecture?: {
    tokenizer?: unknown
    input_modalities?: unknown
  }
  context_length?: unknown
  description?: unknown
  id?: unknown
  name?: unknown
  pricing?: {
    completion?: unknown
    prompt?: unknown
  }
}

interface OpenRouterModelsResponse {
  data?: unknown
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function pricePerMtok(value: unknown): number | undefined {
  const price = numberValue(value)
  if (price === undefined) return undefined
  return Number((price * 1_000_000).toFixed(6))
}

function positiveInteger(value: unknown): number | undefined {
  const number = numberValue(value)
  if (number === undefined || number <= 0) return undefined
  return Math.round(number)
}

function sanitizeFamily(value: string | undefined): string | undefined {
  if (!value) return undefined
  const family = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return family || undefined
}

function inferFamily(modelId: string, modelName: string, tokenizer?: string): string | undefined {
  const normalizedTokenizer = sanitizeFamily(tokenizer)
  if (normalizedTokenizer && normalizedTokenizer !== 'unknown') return normalizedTokenizer

  const slug = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId
  return sanitizeFamily(slug.split(/[-:/]/)[0]) ?? sanitizeFamily(modelName.split(/\s+/)[0])
}

/**
 * Whether a listing accepts image input, from its advertised input modalities.
 * Returns undefined when the modalities aren't reported so the UI can stay silent.
 */
function supportsImageInput(inputModalities: unknown): boolean | undefined {
  if (!Array.isArray(inputModalities)) return undefined
  return inputModalities.some((modality) => typeof modality === 'string' && modality.toLowerCase() === 'image')
}

function iconForModelId(modelId: string): string | undefined {
  const vendor = modelId.split('/')[0]?.toLowerCase().replace(/^~/, '')
  switch (vendor) {
    case 'anthropic':
      return 'anthropic'
    case 'openai':
      return 'openai'
    case 'z-ai':
    case 'zai':
      return 'zai'
    case 'x-ai':
    case 'xai':
      return 'xai'
    default:
      return undefined
  }
}

function shortBlurb(description: string | undefined): string | undefined {
  if (!description) return undefined
  const singleLine = description.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= 180) return singleLine
  return `${singleLine.slice(0, 177).trimEnd()}...`
}

function mapOpenRouterModel(model: OpenRouterModelListing): ModelSearchResult | null {
  const id = stringValue(model.id)
  const label = stringValue(model.name) ?? id
  if (!id || !label) return null

  const inputPerMtok = pricePerMtok(model.pricing?.prompt)
  const outputPerMtok = pricePerMtok(model.pricing?.completion)
  const family = inferFamily(id, label, stringValue(model.architecture?.tokenizer))
  const isClaude = id.toLowerCase().includes('claude') || label.toLowerCase().includes('claude')
  const isGpt = family === 'gpt'
  const imageInput = supportsImageInput(model.architecture?.input_modalities)

  return {
    id,
    label,
    family,
    icon: iconForModelId(id),
    blurb: shortBlurb(stringValue(model.description)),
    supportedEfforts: DISCOVERED_MODEL_EFFORTS,
    ...(inputPerMtok !== undefined && outputPerMtok !== undefined
      ? { pricing: { inputPerMtok, outputPerMtok } }
      : {}),
    ...(positiveInteger(model.context_length) ? { contextWindow: positiveInteger(model.context_length) } : {}),
    ...(isClaude ? {} : { supportsWebSearch: false }),
    ...(imageInput !== undefined ? { supportsImageInput: imageInput } : {}),
    ...(isGpt ? { promptHints: GPT_TOOL_USE_PROMPT_HINTS } : {}),
  }
}

export class OpenRouterLlmProvider extends BaseLlmProvider {
  readonly id = 'openrouter' as const
  readonly name = 'OpenRouter'
  override readonly supportsModelSearch = true
  protected readonly settingsKeyField = 'openrouterApiKey' as const
  protected readonly envVarName = 'OPENROUTER_API_KEY'

  createClient(): Anthropic {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('OpenRouter API key not configured')
    // OpenRouter uses the Anthropic-compatible API with Bearer auth.
    // apiKey must be empty string so the SDK doesn't send x-api-key header;
    // authToken sends the OpenRouter key via the Authorization: Bearer header.
    return new Anthropic({
      apiKey: '',
      baseURL: OPENROUTER_BASE_URL,
      authToken: apiKey,
    })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return OPENROUTER_CATALOG
  }

  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return 'haiku'
      case 'agent': return 'sonnet'
      case 'browser': return 'sonnet'
      case 'dashboard': return 'opus'
    }
  }

  getContainerEnvVars(): Record<string, string | undefined> {
    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: this.getEffectiveApiKey(),
    }
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const client = new Anthropic({
        apiKey: '',
        baseURL: OPENROUTER_BASE_URL,
        authToken: apiKey,
      })
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Invalid API key' }
    }
  }

  override async searchModels(query: string): Promise<ModelSearchResult[]> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('OpenRouter API key not configured')

    const params = new URLSearchParams()
    const q = query.trim()
    if (q) params.set('q', q)
    params.set('output_modalities', 'text')
    params.set('sort', 'most-popular')

    const response = await fetch(`${OPENROUTER_BASE_URL}/v1/models?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })
    if (!response.ok) {
      throw new Error(`OpenRouter model search failed (${response.status})`)
    }

    const body = await response.json() as OpenRouterModelsResponse
    const data = Array.isArray(body.data) ? body.data : []
    return data
      .map((model) => mapOpenRouterModel(model as OpenRouterModelListing))
      .filter((model): model is ModelSearchResult => model !== null)
      .slice(0, DISCOVERED_MODEL_LIMIT)
  }
}
