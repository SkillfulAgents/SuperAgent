/**
 * LLM Provider Helpers
 *
 * Shared utilities for creating LLM clients and extracting responses,
 * eliminating repeated boilerplate across services and route handlers.
 */

import { getActiveLlmProvider } from './index'
import { withRetry } from '../utils/retry'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * Get a configured Anthropic client from the active LLM provider.
 * Throws if the API key is not configured.
 */
export function getConfiguredLlmClient(): Anthropic {
  const provider = getActiveLlmProvider()
  if (!provider.getApiKeyStatus().isConfigured) {
    throw new Error('LLM API key not configured')
  }
  return provider.createClient()
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
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, 'max_tokens'>,
): Promise<string | null> {
  const response = await withRetry(() =>
    client.messages.create({ ...request, max_tokens: SUMMARIZER_MAX_TOKENS }),
  )
  const text = extractTextFromLlmResponse(response)
  // Retry on ANY text-less response, not just stop_reason 'max_tokens' — some
  // Anthropic-compat endpoints return thinking-only output with 'end_turn' or
  // a nonstandard stop_reason. One wasted call in the rare non-thinking case
  // beats silently returning null.
  if (text) return text

  try {
    const retried = await withRetry(() =>
      client.messages.create({
        ...request,
        max_tokens: SUMMARIZER_MAX_TOKENS,
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
