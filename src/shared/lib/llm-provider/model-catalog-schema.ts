import { z } from 'zod'
import { EFFORT_LEVELS } from '../container/types'

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
  /** Grouping key and bare alias for this lineage, e.g. 'opus'. */
  family: z.string().optional(),
  /** This id is what the bare `family` alias resolves to (newest in the family). */
  isLatest: z.boolean().optional(),
  /**
   * Whether this model supports the agent's web search / fetch path (the
   * Anthropic-native server tools, which only work when Anthropic serves the
   * request). Omit/undefined ⇒ supported (all Claude models). Set `false` for
   * non-Claude models routed via OpenRouter so the picker can warn.
   */
  supportsWebSearch: z.boolean().optional(),
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
})

export type ModelDefinition = z.infer<typeof modelDefinitionSchema>

export const modelCatalogSchema = z.array(modelDefinitionSchema)
