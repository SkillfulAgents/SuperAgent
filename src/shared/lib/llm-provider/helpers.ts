import { HelperConfigurationError } from './helper-error'
import { resolveHelperSelection, type ResolvedConnection } from './connections'
import { effectiveModelsFrom, getSettings, type AppSettings, type ModelSettings } from '../config/settings'
/**
 * LLM Provider Helpers
 *
 * Shared utilities for creating LLM clients and extracting responses,
 * eliminating repeated boilerplate across services and route handlers.
 */

import { activeLlmProviderFrom, resolveModelForProviderFrom } from './index'
import type { BaseLlmProvider, ModelPurpose } from './base-llm-provider'
import { NonRetryableError, withRetry } from '../utils/retry'
import type Anthropic from '@anthropic-ai/sdk'

const helperModels = new WeakMap<Anthropic, string>()
export function configuredHelperModel(client: Anthropic): string | undefined {
  return helperModels.get(client)
}

// The model setting a helper call for each purpose reads when no summarizer
// connection is selected (legacy settings without an app default).
const HELPER_MODEL_SETTINGS = {
  summarizer: 'summarizerModel',
  agent: 'agentModel',
  browser: 'browserModel',
  dashboard: 'dashboardBuilderModel',
} as const satisfies Record<ModelPurpose, keyof ModelSettings>

export interface HelperSetup {
  /** The provider helper calls go to. */
  provider: BaseLlmProvider
  /** The summarizer connection, when an app default is set; null on legacy settings. */
  selection: ResolvedConnection | null
  /** The wire model to ask for: the connection's helper model, else `purpose`'s setting for the active provider. */
  model: string
  /** Whether that provider has its credentials. */
  configured: boolean
}

/**
 * What a host-direct helper call runs on, from the settings the operation
 * already read: with an app default, the summarizer connection
 * ({@link resolveHelperSelection}, which throws HelperConfigurationError when
 * none can serve) and its model; otherwise the active provider and the
 * `purpose` model setting resolved for it. Reads no settings itself.
 */
export async function helperSetupFrom(settings: AppSettings, purpose: ModelPurpose = 'summarizer'): Promise<HelperSetup> {
  const selection = settings.llmDefault ? await resolveHelperSelection(settings) : null
  const provider = selection?.provider ?? activeLlmProviderFrom(settings)
  // The fallback model is resolved only when no connection names one.
  const model = selection?.wireModel
    ?? resolveModelForProviderFrom(effectiveModelsFrom(settings)[HELPER_MODEL_SETTINGS[purpose]], provider.id, purpose, settings)
  return { provider, selection, model, configured: provider.apiKeyStatusFrom(settings).isConfigured }
}

/**
 * A client for host-direct helper calls and the model to ask it for, from the
 * settings the operation already read. Throws when the helper provider has no
 * credentials or cannot be called directly. Build one per call; never keep it.
 */
export async function configuredLlmClientFrom(
  settings: AppSettings,
  purpose: ModelPurpose = 'summarizer',
): Promise<{ client: Anthropic; model: string }> {
  const helper = await helperSetupFrom(settings, purpose)
  if (!helper.configured) {
    if (helper.provider.id === 'platform') throw new HelperConfigurationError('Reconnect Platform or choose another summarizer in Settings → Model Providers')
    throw new Error('LLM API key not configured')
  }
  if (!helper.selection && helper.provider.supportsDirectApi === false) throw new HelperConfigurationError()
  const client = await helper.provider.createClientFrom(settings)
  if (helper.selection) helperModels.set(client, helper.selection.wireModel)
  return { client, model: helper.model }
}

/**
 * {@link configuredLlmClientFrom} from one settings read: the client and the
 * model in one call, so summarizer callers need not read the settings again
 * to pick a model.
 */
export async function getConfiguredLlmClientAndModel(purpose: ModelPurpose = 'summarizer'): Promise<{ client: Anthropic; model: string }> {
  return configuredLlmClientFrom(await getSettings(), purpose)
}

/**
 * Get a configured Anthropic client from the active LLM provider.
 * Throws if the API key is not configured.
 */
export async function getConfiguredLlmClient(): Promise<Anthropic> {
  return (await getConfiguredLlmClientAndModel()).client
}

/**
 * Token budget for host-direct summarizer calls (session/agent naming, PR
 * metadata). Thinking-first models (qwen, Spark, other reasoners reached via
 * the generic provider) emit several hundred thinking tokens before any text;
 * a budget sized to the expected text alone gets fully consumed by thinking
 * and the response carries no text block at all.
 */
export const SUMMARIZER_MAX_TOKENS = 2000

/**
 * Thinking cap for the retry path in createSummarizerText. Some thinking-first
 * models (qwen via ollama) ruminate indefinitely when uncapped; an explicit
 * budget forces them to stop thinking and emit text.
 */
const SUMMARIZER_THINKING_BUDGET = 1024

/**
 * Extract the text content from an Anthropic message response.
 * Returns the trimmed text from the first text block, or null if none found.
 */
export function extractTextFromLlmResponse(
  response: Anthropic.Message,
): string | null {
  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') return null
  return textBlock.text.trim() || null
}

/**
 * Run a summarizer-purpose completion (naming, PR metadata) and return its
 * text, tolerating thinking-first models. Such models spend output tokens on
 * thinking before any text, so a response can consume the whole budget and
 * carry no text block at all. When that happens (text-less + max_tokens), the
 * call is retried once with an explicit thinking cap so text can follow.
 * Models that would reject the thinking param never reach the retry — they
 * return text on the first attempt.
 */
export async function createSummarizerText(
  client: Anthropic,
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, 'max_tokens'> & { max_tokens?: number },
  signal?: AbortSignal,
): Promise<string | null> {
  const maxTokens = request.max_tokens ?? SUMMARIZER_MAX_TOKENS
  request = { ...request, model: helperModels.get(client) ?? request.model }
  const create = async (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> => {
    if (signal?.aborted) {
      throw new NonRetryableError('Summarizer request aborted')
    }
    try {
      return signal
        ? await client.messages.create(params, { signal })
        : await client.messages.create(params)
    } catch (error) {
      // An aborted provider request must not enter withRetry's backoff loop or
      // start another billable attempt after its caller has already fallen back.
      if (signal?.aborted) {
        throw new NonRetryableError('Summarizer request aborted')
      }
      throw error
    }
  }

  const response = await withRetry(() =>
    create({ ...request, max_tokens: maxTokens }),
  )
  const text = extractTextFromLlmResponse(response)
  // Retry on ANY text-less response, not just stop_reason 'max_tokens' — some
  // Anthropic-compat endpoints return thinking-only output with 'end_turn' or
  // a nonstandard stop_reason. One wasted call in the rare non-thinking case
  // beats silently returning null.
  if (text) return text

  try {
    const retried = await withRetry(() =>
      create({
        ...request,
        max_tokens: maxTokens,
        thinking: { type: 'enabled', budget_tokens: SUMMARIZER_THINKING_BUDGET },
      }),
    )
    const retriedText = extractTextFromLlmResponse(retried)
    if (!retriedText) {
      console.warn(
        `Summarizer call returned no text even after thinking-capped retry (model: ${request.model}, stop_reason: ${retried.stop_reason})`,
      )
    }
    return retriedText
  } catch (error) {
    // Endpoints that don't accept the thinking param reject the retry; the
    // first attempt already failed, so report that rather than throwing.
    console.warn(
      `Summarizer thinking-capped retry failed (model: ${request.model}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}
