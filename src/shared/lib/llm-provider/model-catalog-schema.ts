import { z } from 'zod'
import { EFFORT_LEVELS, SPEED_LEVELS } from '../container/types'

/**
 * A concrete, versioned model offered by a provider's catalog.
 *
 * The `id` is BOTH the catalog key and the exact wire value sent to the SDK
 * (e.g. 'claude-opus-4-8', 'us.anthropic.claude-opus-4-8'). A stored model
 * selection is always a single string whose shape decides how it resolves:
 *   - a bare `family` alias ('opus')  → that family's `isLatest` id (rides upgrades)
 *   - a concrete `id` ('claude-opus-4-8') → pinned exactly
 * See {@link ./model-catalog.ts resolveModelForProvider} for the resolution rules.
 */
export const modelDefinitionSchema = z.object({
  /** Concrete versioned id and wire value, e.g. 'claude-opus-4-8'. */
  id: z.string().min(1),
  /** Display label, e.g. 'Opus 4.8'. */
  label: z.string().min(1),
  /** Short one-liner shown under the label in pickers. */
  blurb: z.string().optional(),
  /** Brand key, e.g. 'anthropic' → bundled asset resolved by the renderer. */
  icon: z.string().optional(),
  /**
   * Reasoning-effort levels this model accepts. Replaces the old
   * family-keyed EFFORT_FAMILY_REQUIREMENTS — now declared per model.
   */
  supportedEfforts: z.array(z.enum(EFFORT_LEVELS)).min(1),
  /**
   * Processing-speed tiers this model accepts on its serving path (normalized
   * to slow/normal/fast). Omit ⇒ ['normal'] — a speed knob is the exception,
   * not the rule, so absence means "no speed choice".
   */
  supportedSpeeds: z.array(z.enum(SPEED_LEVELS)).min(1).optional(),
  /** Grouping key and bare alias for this lineage, e.g. 'opus'. */
  family: z.string().optional(),
  /** This id is what the bare `family` alias resolves to (newest in the family). */
  isLatest: z.boolean().optional(),
  // Omit/undefined ⇒ supported (Claude). false ⇒ OpenRouter non-Claude, etc.
  supportsWebSearch: z.boolean().optional(),
  // Omit/undefined ⇒ follow supportsWebSearch. false when search works but fetch does not (Platform Responses).
  supportsWebFetch: z.boolean().optional(),
  // Vision. Populated from provider modalities during model search; omit ⇒ unknown.
  supportsImageInput: z.boolean().optional(),
  /** Extra system-prompt guidance needed by model families with weaker tool priors. */
  promptHints: z.array(z.string().min(1)).optional(),
  /**
   * Optional display pricing (per-million-token). Built-ins seed this from
   * model-pricing.json; actual cost accounting still keys off that file.
   */
  pricing: z
    .object({
      inputPerMtok: z.number().nonnegative(),
      outputPerMtok: z.number().nonnegative(),
    })
    .optional(),
  // Static context window (tokens) for non-Claude models. The SDK reports a
  // generic 200K default for these, so the host prefers this over the SDK value
  // (see handleResultUsage). Claude entries omit it and use the SDK's real window.
  contextWindow: z.number().int().positive().optional(),
  // Long-context pricing cliff: above `thresholdTokens` of input, the provider
  // reprices the whole request by these multipliers (e.g. OpenAI's 272K cliff).
  // Present ⇒ the picker warns. Omit for flat-priced models.
  longContextPriceCliff: z
    .object({
      thresholdTokens: z.number().int().positive(),
      inputMultiplier: z.number().positive(),
      outputMultiplier: z.number().positive(),
    })
    .optional(),
})

export type ModelDefinition = z.infer<typeof modelDefinitionSchema>

/**
 * Normalized provider-discovery result. Providers may source this from their
 * own catalogs, but by the time it reaches the renderer it is already shaped
 * like a model that can be added to the local catalog.
 */
export const modelSearchResultSchema = modelDefinitionSchema
export type ModelSearchResult = z.infer<typeof modelSearchResultSchema>

export const modelCatalogSchema = z.array(modelDefinitionSchema)

export const catalogOverrideEntrySchema = modelDefinitionSchema.partial().extend({
  id: z.string().min(1),
  disabled: z.boolean().optional(),
})

export const providerCatalogOverridesSchema = z.object({
  overrides: z.array(catalogOverrideEntrySchema).default([]),
})

export const modelCatalogSettingsSchema = z.record(
  z.string(),
  providerCatalogOverridesSchema,
)

export type CatalogOverrideEntry = z.infer<typeof catalogOverrideEntrySchema>
export type ProviderCatalogOverrides = z.infer<typeof providerCatalogOverridesSchema>
export type ModelCatalogSettings = z.infer<typeof modelCatalogSettingsSchema>
