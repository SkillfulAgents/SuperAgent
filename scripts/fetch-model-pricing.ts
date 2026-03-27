#!/usr/bin/env npx tsx
/**
 * Fetch Claude model pricing from LiteLLM's model pricing database
 * and write a JSON file for use by the usage service.
 *
 * Run: npx tsx scripts/fetch-model-pricing.ts
 */

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

const OUTPUT_PATH = 'src/shared/lib/services/model-pricing.json'

interface LiteLLMModel {
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_creation_input_token_cost?: number
  cache_read_input_token_cost?: number
  litellm_provider?: string
}

interface PricingEntry {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

async function main() {
  console.log('Fetching model pricing from LiteLLM...')
  const res = await fetch(LITELLM_URL)
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
  }

  const data: Record<string, LiteLLMModel> = await res.json()

  // Filter to Claude models from Anthropic direct API (not bedrock/vertex/etc)
  const pricing: Record<string, PricingEntry> = {}

  for (const [key, model] of Object.entries(data)) {
    // Only include direct Anthropic models (no provider prefix like "anthropic.", "bedrock/", etc)
    if (!key.startsWith('claude-')) continue
    if (!model.input_cost_per_token || !model.output_cost_per_token) continue

    // Convert per-token to per-million-token
    pricing[key] = {
      input: round(model.input_cost_per_token * 1e6),
      output: round(model.output_cost_per_token * 1e6),
      cacheCreation: round((model.cache_creation_input_token_cost ?? 0) * 1e6),
      cacheRead: round((model.cache_read_input_token_cost ?? 0) * 1e6),
    }
  }

  const sortedPricing: Record<string, PricingEntry> = {}
  for (const key of Object.keys(pricing).sort()) {
    sortedPricing[key] = pricing[key]
  }

  const fs = await import('fs')
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(sortedPricing, null, 2) + '\n'
  )

  console.log(`Wrote ${Object.keys(sortedPricing).length} models to ${OUTPUT_PATH}`)
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
