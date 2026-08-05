import { z } from 'zod'
import type { LlmProviderId } from '../llm-provider'
import { getEffectiveCatalog } from '../llm-provider'

export const MAX_SUBAGENT_MODELS = 32

export const subagentModelDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  blurb: z.string().optional(),
  family: z.string().optional(),
  isLatest: z.boolean().optional(),
  supportsWebSearch: z.boolean().optional(),
  supportsWebFetch: z.boolean().optional(),
  supportsImageInput: z.boolean().optional(),
  promptHints: z.array(z.string().min(1)).optional(),
  pricing: z
    .object({
      inputPerMtok: z.number().nonnegative(),
      outputPerMtok: z.number().nonnegative(),
    })
    .optional(),
  contextWindow: z.number().int().positive().optional(),
})

export const subagentModelCatalogSchema = z
  .array(subagentModelDefinitionSchema)
  .max(MAX_SUBAGENT_MODELS)

export type SubagentModelDefinition = z.infer<typeof subagentModelDefinitionSchema>

export function getSubagentModelCatalog(providerId: LlmProviderId): SubagentModelDefinition[] {
  return subagentModelCatalogSchema.parse(
    getEffectiveCatalog(providerId)
      .slice(0, MAX_SUBAGENT_MODELS)
      .map((model) => ({
        id: model.id,
        label: model.label,
        blurb: model.blurb,
        family: model.family,
        isLatest: model.isLatest,
        supportsWebSearch: model.supportsWebSearch,
        supportsWebFetch: model.supportsWebFetch,
        supportsImageInput: model.supportsImageInput,
        promptHints: model.promptHints,
        pricing: model.pricing && {
          inputPerMtok: model.pricing.inputPerMtok,
          outputPerMtok: model.pricing.outputPerMtok,
        },
        contextWindow: model.contextWindow,
      })),
  )
}
