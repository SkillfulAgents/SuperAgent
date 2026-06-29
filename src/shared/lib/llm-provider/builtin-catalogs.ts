import type { EffortLevel } from '../container/types'
import type { ModelDefinition } from './model-catalog-schema'
import { GPT_TOOL_USE_PROMPT_HINTS } from './model-prompt-hints'
import { pricingFor } from './model-pricing-lookup'

/**
 * Built-in model catalogs shipped in code, one shape per provider.
 *
 * Each provider's getBuiltinCatalog() returns one of these. Anthropic uses
 * CLAUDE_BARE_CATALOG; OpenRouter and Platform extend it with non-Claude models
 * (different ids/pricing per upstream); Bedrock uses region-prefixed Claude ids.
 *
 * `isLatest` marks the id a bare family alias resolves to. Effort support is
 * per model: Opus/Fable accept all five levels, Sonnet/Haiku the lower three.
 */

const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STANDARD_EFFORTS: EffortLevel[] = ['low', 'medium', 'high']
// xhigh/max are Anthropic-only reasoning tiers; non-Claude models get the standard three.
const NON_CLAUDE_EFFORTS: EffortLevel[] = ['low', 'medium', 'high']

// OpenAI GPT-5.x reprice the whole request 2x input / 1.5x output once prompt
// input crosses 272K tokens. Shared by every GPT entry so the picker can warn.
const GPT_LONG_CONTEXT_CLIFF = {
  thresholdTokens: 272_000,
  inputMultiplier: 2,
  outputMultiplier: 1.5,
} as const

const ICON = 'anthropic'

/** Anthropic / OpenRouter / Platform — bare Claude ids. */
export const CLAUDE_BARE_CATALOG: ModelDefinition[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    blurb: 'Fastest and most affordable',
    family: 'haiku',
    isLatest: true,
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-haiku-4-5'),
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    blurb: 'Balanced speed and capability',
    family: 'sonnet',
    isLatest: true,
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-sonnet-4-6'),
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    family: 'opus',
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-6'),
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    family: 'opus',
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-7'),
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    blurb: 'Most capable',
    family: 'opus',
    isLatest: true,
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-8'),
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    family: 'fable',
    isLatest: true,
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-fable-5'),
  },
]

/** AWS Bedrock — region-prefixed ids, same families; pricing seeded from the bare id. */
export const BEDROCK_CATALOG: ModelDefinition[] = [
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    label: 'Haiku 4.5',
    blurb: 'Fastest and most affordable',
    family: 'haiku',
    isLatest: true,
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-haiku-4-5'),
  },
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    blurb: 'Balanced speed and capability',
    family: 'sonnet',
    isLatest: true,
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-sonnet-4-6'),
  },
  {
    id: 'us.anthropic.claude-opus-4-6-v1',
    label: 'Opus 4.6',
    family: 'opus',
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-6'),
  },
  {
    id: 'us.anthropic.claude-opus-4-7',
    label: 'Opus 4.7',
    family: 'opus',
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-7'),
  },
  {
    id: 'us.anthropic.claude-opus-4-8',
    label: 'Opus 4.8',
    blurb: 'Most capable',
    family: 'opus',
    isLatest: true,
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-8'),
  },
  {
    id: 'us.anthropic.claude-fable-5',
    label: 'Fable 5',
    family: 'fable',
    isLatest: true,
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-fable-5'),
  },
]

/**
 * Curated non-Claude models OpenRouter can route to. OpenRouter uses
 * `vendor/model` slugs, which pass straight through the resolver and the
 * container to OpenRouter's Anthropic-compatible endpoint.
 */
const OPENROUTER_EXTRA_MODELS: ModelDefinition[] = [
  {
    id: 'openai/gpt-5.4',
    label: 'GPT-5.4',
    blurb: 'OpenAI, routed via OpenRouter',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    // Baked from OpenRouter's live model list (per-Mtok USD), fetched 2026-06-18.
    pricing: { inputPerMtok: 2.5, outputPerMtok: 15 },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.4).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'openai/gpt-5.5',
    label: 'GPT-5.5',
    blurb: 'OpenAI flagship, routed via OpenRouter',
    family: 'gpt',
    isLatest: true,
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    // The agent's web search/fetch are Anthropic-native server tools; they don't
    // work when OpenRouter routes to a non-Claude model. Flag so the picker warns.
    supportsWebSearch: false,
    // Non-Claude ids aren't in model-pricing.json; baked from OpenRouter's live
    // model list (per-Mtok USD), fetched 2026-06-18. Refresh if OpenRouter repricing.
    pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.5).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM-5.2',
    blurb: 'Z.AI GLM, routed via OpenRouter',
    family: 'glm',
    isLatest: true,
    icon: 'zai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    // Baked from OpenRouter's live model list (per-Mtok USD), fetched 2026-06-18.
    pricing: { inputPerMtok: 1.2, outputPerMtok: 4.2 },
  },
]

/** OpenRouter — the bare Claude models plus curated non-Claude built-ins. */
export const OPENROUTER_CATALOG: ModelDefinition[] = [
  ...CLAUDE_BARE_CATALOG,
  ...OPENROUTER_EXTRA_MODELS,
]

/**
 * Non-Claude models the Platform proxy can serve. Unlike OpenRouter these use
 * BARE ids (`gpt-5.5`): the proxy's routing/pricing all key off bare ids, so a
 * vendor-prefixed slug would miss every match.
 */
const PLATFORM_EXTRA_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    blurb: 'OpenAI, served via Platform',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    // Platform serves gpt over the OpenAI Responses wire, which maps the agent's
    // web_search server tool to the native web_search tool — so search works.
    supportsWebSearch: true,
    pricing: { inputPerMtok: 2.5, outputPerMtok: 15 },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.4).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    blurb: 'OpenAI flagship, served via Platform',
    family: 'gpt',
    isLatest: true,
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: true,
    pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.5).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'glm-5.2',
    label: 'GLM-5.2',
    blurb: 'Z.AI GLM, served via Fireworks on Platform',
    family: 'glm',
    isLatest: true,
    icon: 'zai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    supportsImageInput: false,
    pricing: { inputPerMtok: 1.4, outputPerMtok: 4.4 },
    contextWindow: 1_040_000,
  },
  {
    id: 'kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    blurb: 'Moonshot coding model, served via Fireworks on Platform',
    family: 'kimi',
    isLatest: true,
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    supportsImageInput: true,
    pricing: { inputPerMtok: 0.95, outputPerMtok: 4 },
    contextWindow: 262_144,
  },
]

/** Platform — bare Claude models plus the GPT models the proxy serves. */
export const PLATFORM_CATALOG: ModelDefinition[] = [
  ...CLAUDE_BARE_CATALOG,
  ...PLATFORM_EXTRA_MODELS,
]
