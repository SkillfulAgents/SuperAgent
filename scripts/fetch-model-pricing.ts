#!/usr/bin/env npx tsx
/**
 * Fetch Claude model pricing from LiteLLM's model pricing database
 * and merge its flat rates into the pricing table used by the usage service.
 * Curated metadata and non-Claude entries already in the table are preserved.
 *
 * Run: npx tsx scripts/fetch-model-pricing.ts
 */

import {
  getPricingRefreshDriftWarnings,
  mergeRefreshedModelPricing,
  type FlatModelPricing,
  type ModelPricingTable,
} from './lib/model-pricing-merge'

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

async function main() {
  console.log('Fetching model pricing from LiteLLM...')
  const res = await fetch(LITELLM_URL)
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`)
  }

  const data: Record<string, LiteLLMModel> = await res.json()

  // Filter to Claude models from Anthropic direct API (not bedrock/vertex/etc)
  const refreshedPricing: Record<string, FlatModelPricing> = {}

  for (const [key, model] of Object.entries(data)) {
    // Only include direct Anthropic models (no provider prefix like "anthropic.", "bedrock/", etc)
    if (!key.startsWith('claude-')) continue
    if (!model.input_cost_per_token || !model.output_cost_per_token) continue

    // Convert per-token to per-million-token
    refreshedPricing[key] = {
      input: round(model.input_cost_per_token * 1e6),
      output: round(model.output_cost_per_token * 1e6),
      cacheCreation: round((model.cache_creation_input_token_cost ?? 0) * 1e6),
      cacheRead: round((model.cache_read_input_token_cost ?? 0) * 1e6),
    }
  }

  const fs = await import('fs')
  let existingPricing: ModelPricingTable
  try {
    existingPricing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) as ModelPricingTable
  } catch (error) {
    throw new Error(`Failed to read existing pricing table at ${OUTPUT_PATH}`, { cause: error })
  }
  for (const warning of getPricingRefreshDriftWarnings(existingPricing, refreshedPricing)) {
    console.warn(warning)
  }
  const mergedPricing = mergeRefreshedModelPricing(existingPricing, refreshedPricing)
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(mergedPricing, null, 2) + '\n'
  )

  console.log(
    `Refreshed ${Object.keys(refreshedPricing).length} Claude models; wrote ${Object.keys(mergedPricing).length} total models to ${OUTPUT_PATH}`,
  )
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
