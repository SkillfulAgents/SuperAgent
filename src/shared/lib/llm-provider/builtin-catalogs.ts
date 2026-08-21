import type { EffortLevel, SpeedLevel } from '../container/types'
import type { ProviderDefaultModelOption } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { GPT_TOOL_USE_PROMPT_HINTS, GROK_BROWSER_TOOL_PROMPT_HINTS } from './model-prompt-hints'
import { pricingFor } from './model-pricing-lookup'

/**
 * Built-in model catalogs shipped in code, one shape per provider.
 *
 * Each provider's getBuiltinCatalog() returns one of these. Anthropic uses
 * CLAUDE_BARE_CATALOG; OpenRouter and Platform extend it with non-Claude models
 * (different ids/pricing per upstream); Bedrock uses region-prefixed Claude ids.
 *
 * `isLatest` marks the id a bare family alias resolves to. `isDefault` marks
 * the concrete model selected when switching to that model vendor in the
 * picker; it is intentionally independent from recency. Effort support is per
 * model: Opus/Fable accept all five levels, Sonnet/Haiku the lower three.
 */

const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const STANDARD_EFFORTS: EffortLevel[] = ['low', 'medium', 'high']
// xhigh/max are Anthropic-only reasoning tiers; non-Claude models get the standard three.
const NON_CLAUDE_EFFORTS: EffortLevel[] = ['low', 'medium', 'high']

/**
 * Processing-speed tiers, normalized to slow/normal/fast. `supportedSpeeds`
 * reflects what OUR serving path can honor, not the vendor's raw feature list:
 * the agent signals speed via the X-Superagent-Speed custom header, which only
 * the Platform proxy consumes (mapping it to OpenAI/xAI `service_tier` or
 * Anthropic fast mode). Direct Anthropic (body param + gated beta on the
 * user's own key), OpenRouter (ignores our header; Anthropic fast exists there
 * only as separate `-fast` model slugs), and Bedrock (no fast mode) can't
 * honor a pick, so their entries omit speeds entirely.
 *
 * Vendor mapping, verified 2026-07-14:
 *   - OpenAI GPT-5.x: `service_tier` flex (0.5x price, slower) / priority
 *     (2x, 2.5x on gpt-5.5) → slow/normal/fast.
 *   - xAI grok: `service_tier` priority only (2x when granted) → normal/fast.
 *   - Anthropic: fast mode (research preview) on Opus 4.8 only → normal/fast.
 *   - Z.AI GLM: no request-level tier → normal only.
 *   - Fireworks (kimi-k3): fast is a separate `-fast` router resource, not a
 *     request param — the proxy swaps the outbound model id → normal/fast.
 */
const FLEX_AND_PRIORITY_SPEEDS: SpeedLevel[] = ['slow', 'normal', 'fast']
const PRIORITY_ONLY_SPEEDS: SpeedLevel[] = ['normal', 'fast']

/**
 * Served-tier billing multipliers, mirroring the Platform proxy's pricing:
 * OpenAI flex bills 0.5x and priority 2x (2.5x on gpt-5.5); xAI priority and
 * Anthropic fast mode bill 2x. Standard tier (absent speed) is always 1x.
 * Claude entries get theirs from model-pricing.json via pricingFor().
 */
const GPT_SPEED_MULTIPLIERS = { slow: 0.5, fast: 2 } as const
const GPT_55_SPEED_MULTIPLIERS = { slow: 0.5, fast: 2.5 } as const
const PRIORITY_2X_MULTIPLIERS = { fast: 2 } as const
// Fireworks prices its fast routers as a separate SKU rather than a tier
// surcharge; for kimi-k3 that SKU is a flat 1.5x on every rate ($4.50/$22.50
// against $3/$15), so one multiplier covers it.
const FIREWORKS_FAST_MULTIPLIERS = { fast: 1.5 } as const

// Anthropic fast mode covers Opus 5 and 4.8 (4.7's was removed 2026-07-24).
const FAST_MODE_CLAUDE_IDS = new Set(['claude-opus-4-8', 'claude-opus-5'])

/** Claude entries with the speed tiers the Platform proxy can request. */
function withPlatformClaudeSpeeds(catalog: ModelDefinition[]): ModelDefinition[] {
  return catalog.map((m) =>
    FAST_MODE_CLAUDE_IDS.has(m.id) ? { ...m, supportedSpeeds: PRIORITY_ONLY_SPEEDS } : m,
  )
}

// OpenAI GPT-5.x reprice the whole request 2x input / 1.5x output once prompt
// input crosses 272K tokens. Shared by every GPT entry so the picker can warn.
const GPT_LONG_CONTEXT_CLIFF = {
  thresholdTokens: 272_000,
  inputMultiplier: 2,
  outputMultiplier: 1.5,
} as const

// xAI doubles every rate once prompt input reaches 200K tokens.
const GROK_LONG_CONTEXT_CLIFF = {
  thresholdTokens: 200_000,
  inputMultiplier: 2,
  outputMultiplier: 2,
} as const

const ICON = 'anthropic'

/** Default-model shortlist for providers whose onboarding catalog is Claude-only. */
export const CLAUDE_DEFAULT_MODEL_OPTIONS: readonly ProviderDefaultModelOption[] = [
  {
    model: 'opus',
    label: 'Opus',
    tag: 'Most capable',
    description: 'Best for complex, multi-step tasks.',
    subdescription: 'Slower, and uses 5x more credits than Sonnet.',
  },
  {
    model: 'sonnet',
    label: 'Sonnet',
    tag: 'Fast & efficient',
    description: 'Best for everyday tasks and most agent work.',
    subdescription: 'Far lower credit cost than Opus.',
  },
]

/** Platform-specific default-model shortlist. The provider default is Grok. */
export const PLATFORM_DEFAULT_MODEL_OPTIONS: readonly ProviderDefaultModelOption[] = [
  {
    model: 'opus',
    label: 'Opus',
    tag: 'Deep reasoning',
    description: 'Best for complex, multi-step tasks.',
    subdescription: 'A premium choice for the hardest agent work.',
  },
  {
    model: 'gpt',
    label: 'GPT',
    resolveLabelFromCatalog: true,
    tag: 'OpenAI flagship',
    description: 'Strong all-around reasoning and tool use.',
    subdescription: 'A versatile choice for demanding agent work.',
  },
  {
    model: 'grok',
    label: 'Grok',
    resolveLabelFromCatalog: true,
    tag: 'Recommended',
    description: 'Fast, capable, and efficient for everyday agent work.',
    subdescription: 'The default model for Gamut Platform.',
  },
]

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
    family: 'sonnet',
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-sonnet-4-6'),
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    blurb: 'Balanced speed and capability',
    family: 'sonnet',
    isLatest: true,
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-sonnet-5'),
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
    family: 'opus',
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-4-8'),
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    blurb: 'Most capable',
    family: 'opus',
    isLatest: true,
    isDefault: true,
    icon: ICON,
    supportedEfforts: ALL_EFFORTS,
    pricing: pricingFor('claude-opus-5'),
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
    family: 'sonnet',
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-sonnet-4-6'),
  },
  {
    id: 'us.anthropic.claude-sonnet-5',
    label: 'Sonnet 5',
    blurb: 'Balanced speed and capability',
    family: 'sonnet',
    isLatest: true,
    icon: ICON,
    supportedEfforts: STANDARD_EFFORTS,
    pricing: pricingFor('claude-sonnet-5'),
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
    isDefault: true,
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
    isDefault: true,
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
    isDefault: true,
    icon: 'zai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    // Baked from OpenRouter's live model list (per-Mtok USD), fetched 2026-06-18.
    pricing: { inputPerMtok: 1.2, outputPerMtok: 4.2 },
  },
  {
    id: 'x-ai/grok-4.6',
    label: 'Grok 4.6',
    blurb: 'xAI Grok, routed via OpenRouter',
    family: 'grok',
    isLatest: true,
    isDefault: true,
    icon: 'xai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    pricing: { inputPerMtok: 2, outputPerMtok: 6 },
    contextWindow: 500_000,
    longContextPriceCliff: GROK_LONG_CONTEXT_CLIFF,
    promptHints: GROK_BROWSER_TOOL_PROMPT_HINTS,
  },
  {
    id: 'x-ai/grok-4.5',
    label: 'Grok 4.5',
    blurb: 'xAI Grok, routed via OpenRouter',
    family: 'grok',
    icon: 'xai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    // Baked from OpenRouter's live model list (per-Mtok USD), fetched 2026-07-10.
    pricing: { inputPerMtok: 2, outputPerMtok: 6 },
    // OpenRouter-reported context length for x-ai/grok-4.5, fetched 2026-07-10.
    contextWindow: 500_000,
    longContextPriceCliff: GROK_LONG_CONTEXT_CLIFF,
    promptHints: GROK_BROWSER_TOOL_PROMPT_HINTS,
  },
  // Kimi, newest first. The K2 line stays listed because it is an order of
  // magnitude cheaper than K3 and still current on OpenRouter — these are the
  // same two the Platform proxy serves, so a model pick can move between
  // providers. No `supportedSpeeds`: OpenRouter ignores our speed header.
  // All three: pricing and context from OpenRouter's live model list,
  // vision from its advertised input modalities, fetched 2026-07-27.
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    blurb: 'Moonshot AI, routed via OpenRouter',
    family: 'kimi',
    isLatest: true,
    isDefault: true,
    icon: 'kimi',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    pricing: { inputPerMtok: 3, outputPerMtok: 15 },
    contextWindow: 1_048_576,
    supportsImageInput: true,
  },
  {
    id: 'moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    blurb: 'Moonshot AI coding model, routed via OpenRouter',
    family: 'kimi',
    icon: 'kimi',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    pricing: { inputPerMtok: 0.73, outputPerMtok: 3.5 },
    contextWindow: 262_144,
    supportsImageInput: true,
  },
  {
    id: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    blurb: 'Moonshot AI, routed via OpenRouter',
    family: 'kimi',
    icon: 'kimi',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportsWebSearch: false,
    pricing: { inputPerMtok: 0.646, outputPerMtok: 2.72 },
    contextWindow: 262_144,
    supportsImageInput: true,
  },
]

/** OpenRouter — the bare Claude models plus curated non-Claude built-ins. */
export const OPENROUTER_CATALOG: ModelDefinition[] = [
  ...CLAUDE_BARE_CATALOG,
  ...OPENROUTER_EXTRA_MODELS,
]

/**
 * Non-Claude models the Platform proxy can serve. Unlike OpenRouter these use
 * BARE ids (`gpt-5.5`, `grok-4.6`): the proxy's routing/pricing all key off bare
 * ids, so a vendor-prefixed slug would miss every match.
 */
// Responses hosts web_search but not web_fetch — fetch needs a Settings → Web vendor (Exa).
const PLATFORM_RESPONSES_WEB = { supportsWebSearch: true, supportsWebFetch: false } as const

/**
 * Meta's muse-spark family, served via the platform proxy's `meta` upstream.
 *
 * Shared traits, all measured against api.meta.ai (2026-08-10) rather than
 * taken from a spec sheet:
 *   - no speed tiers, so `supportedSpeeds` is omitted entirely;
 *   - the proxy strips Anthropic server tools (Meta hosts none), so neither
 *     search nor fetch runs — web search needs a Settings → Web vendor;
 *   - image input is accepted;
 *   - a 1,000,020-token prompt was accepted and 2.1M rejected, so the window
 *     is somewhere in between. We pin the verified floor rather than guess the
 *     ceiling: under-stating only makes the app compact earlier than it must.
 *
 * The `meta` icon key follows the one-brand-icon-per-vendor convention the
 * catalog test enforces; the mark lives at `public/model-icons/meta.svg`.
 */
const MUSE_SPARK_SHARED = {
  family: 'muse',
  icon: 'meta',
  supportedEfforts: NON_CLAUDE_EFFORTS,
  supportsWebSearch: false,
  supportsWebFetch: false,
  supportsImageInput: true,
  contextWindow: 1_000_000,
} as const

/** Standard-tier rates, identical across muse-spark 1.1 and 1.2. */
const MUSE_SPARK_STANDARD_PRICING = { inputPerMtok: 1.25, outputPerMtok: 4.25 } as const

const MUSE_SPARK_MODELS: ModelDefinition[] = [
  {
    ...MUSE_SPARK_SHARED,
    id: 'muse-spark-1.1',
    label: 'Muse Spark 1.1',
    blurb: 'Meta, served via Platform',
    pricing: MUSE_SPARK_STANDARD_PRICING,
  },
  {
    // Bare id matches the platform proxy's muse-spark-* → meta route.
    ...MUSE_SPARK_SHARED,
    id: 'muse-spark-1.2',
    label: 'Muse Spark 1.2',
    blurb: 'Meta flagship, served via Platform',
    isLatest: true,
    isDefault: true,
    pricing: MUSE_SPARK_STANDARD_PRICING,
  },
  {
    // Meta's discounted tier, ~12x cheaper in exchange for data use: Meta uses
    // Contributor prompts and outputs to improve its products, and has not
    // clarified whether that is training-only. Anything touching customer
    // data, PII, or secrets belongs on the standard tier above — which is what
    // `dataUsedForProductImprovement` puts in front of the user at pick time.
    ...MUSE_SPARK_SHARED,
    id: 'muse-spark-1.2-contributor',
    label: 'Muse Spark 1.2c',
    blurb: 'Meta contributor tier, served via Platform',
    pricing: { inputPerMtok: 0.1, outputPerMtok: 0.2 },
    dataUsedForProductImprovement: true,
  },
]

const PLATFORM_EXTRA_MODELS: ModelDefinition[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    blurb: 'OpenAI, served via Platform',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportedSpeeds: FLEX_AND_PRIORITY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 2.5, outputPerMtok: 15, speedMultipliers: GPT_SPEED_MULTIPLIERS },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.4).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    blurb: 'OpenAI, served via Platform',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportedSpeeds: FLEX_AND_PRIORITY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 5, outputPerMtok: 30, speedMultipliers: GPT_55_SPEED_MULTIPLIERS },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.5).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    blurb: 'OpenAI fastest tier, served via Platform',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportedSpeeds: FLEX_AND_PRIORITY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 1, outputPerMtok: 6, speedMultipliers: GPT_SPEED_MULTIPLIERS },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.6-luna).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    blurb: 'OpenAI balanced tier, served via Platform',
    family: 'gpt',
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportedSpeeds: FLEX_AND_PRIORITY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 2.5, outputPerMtok: 15, speedMultipliers: GPT_SPEED_MULTIPLIERS },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.6-terra).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    // OpenAI's `gpt-5.6` alias routes here; the bare `gpt` family alias follows suit.
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    blurb: 'OpenAI flagship, served via Platform',
    family: 'gpt',
    isLatest: true,
    isDefault: true,
    icon: 'openai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportedSpeeds: FLEX_AND_PRIORITY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 5, outputPerMtok: 30, speedMultipliers: GPT_SPEED_MULTIPLIERS },
    // OpenAI API context window (developers.openai.com/api/docs/models/gpt-5.6-sol).
    contextWindow: 1_050_000,
    longContextPriceCliff: GPT_LONG_CONTEXT_CLIFF,
    promptHints: GPT_TOOL_USE_PROMPT_HINTS,
  },
  {
    // Bare id matches the platform proxy's grok-* → xai-responses route.
    id: 'grok-4.6',
    label: 'Grok 4.6',
    blurb: 'xAI Grok, served via Platform',
    family: 'grok',
    isLatest: true,
    isDefault: true,
    icon: 'xai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    // xAI offers priority but no flex tier — cost-sensitive work goes to their Batch API.
    supportedSpeeds: PRIORITY_ONLY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 2, outputPerMtok: 6, speedMultipliers: PRIORITY_2X_MULTIPLIERS },
    contextWindow: 500_000,
    longContextPriceCliff: GROK_LONG_CONTEXT_CLIFF,
    promptHints: GROK_BROWSER_TOOL_PROMPT_HINTS,
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    blurb: 'xAI Grok, served via Platform',
    family: 'grok',
    icon: 'xai',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    supportedSpeeds: PRIORITY_ONLY_SPEEDS,
    ...PLATFORM_RESPONSES_WEB,
    pricing: { inputPerMtok: 2, outputPerMtok: 6, speedMultipliers: PRIORITY_2X_MULTIPLIERS },
    contextWindow: 500_000,
    longContextPriceCliff: GROK_LONG_CONTEXT_CLIFF,
    promptHints: GROK_BROWSER_TOOL_PROMPT_HINTS,
  },
  {
    // Bare id matches the platform proxy's kimi-* → fireworks route.
    id: 'kimi-k3',
    label: 'Kimi K3',
    blurb: 'Moonshot AI, served via Platform',
    family: 'kimi',
    isLatest: true,
    isDefault: true,
    icon: 'kimi',
    supportedEfforts: NON_CLAUDE_EFFORTS,
    // Fireworks' fast path is a separate router resource the proxy swaps in;
    // it has no flex/slow equivalent.
    supportedSpeeds: PRIORITY_ONLY_SPEEDS,
    // Fireworks' Anthropic-compatible endpoint takes function tools only — the
    // proxy strips Anthropic's server tools, so neither search nor fetch runs.
    supportsWebSearch: false,
    supportsWebFetch: false,
    // Fireworks serverless rates for kimi-k3, from its pricing table (2026-07-27).
    pricing: {
      inputPerMtok: 3,
      outputPerMtok: 15,
      speedMultipliers: FIREWORKS_FAST_MULTIPLIERS,
    },
    // Fireworks-reported `contextLength` for accounts/fireworks/models/kimi-k3.
    contextWindow: 1_048_576,
    supportsImageInput: true,
  },
  ...MUSE_SPARK_MODELS,
]

/** Platform — bare Claude models plus the GPT/Grok models the proxy serves. */
export const PLATFORM_CATALOG: ModelDefinition[] = [
  ...withPlatformClaudeSpeeds(CLAUDE_BARE_CATALOG),
  ...PLATFORM_EXTRA_MODELS,
]
