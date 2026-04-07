/**
 * LLM Provider Helpers
 *
 * Shared utilities for creating LLM clients and extracting responses,
 * eliminating repeated boilerplate across services and route handlers.
 */

import { getActiveLlmProvider } from './index'
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
