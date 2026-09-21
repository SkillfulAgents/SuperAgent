import { z } from 'zod'

export const modelPricingSchema = z.object({
  inputPerMtok: z.number().nonnegative(),
  outputPerMtok: z.number().nonnegative(),
  /** Five-minute prompt-cache write price per million tokens. */
  cacheCreationPerMtok: z.number().nonnegative().optional(),
  /** One-hour prompt-cache write price per million tokens. */
  cacheCreation1hPerMtok: z.number().nonnegative().optional(),
  /** Prompt-cache hit price per million tokens. */
  cacheReadPerMtok: z.number().nonnegative().optional(),
  /** Whole-request long-context multiplier for a custom model. */
  longContextPriceCliff: z
    .object({
      thresholdTokens: z.number().int().positive(),
      inputMultiplier: z.number().positive(),
      outputMultiplier: z.number().positive(),
    })
    .optional(),
  /**
   * Served-tier billing multipliers for the slow/fast speed tiers (e.g.
   * OpenAI flex 0.5x / priority 2x, Anthropic fast mode 2x). Applied on
   * top of whichever rate set (base or long-context) a request lands on.
   * An absent tier bills standard (1x).
   */
  speedMultipliers: z
    .object({
      slow: z.number().positive().optional(),
      fast: z.number().positive().optional(),
    })
    .optional(),
})

export const globalModelPricingSchema = z.record(z.string().min(1), modelPricingSchema)
/** PATCH by model ID; null resets that model to its built-in rate. */
export const globalModelPricingPatchSchema = z.record(
  z.string().min(1),
  modelPricingSchema.nullable(),
)
export type ModelPricing = z.infer<typeof modelPricingSchema>
export type GlobalModelPricing = z.infer<typeof globalModelPricingSchema>
export type GlobalModelPricingPatch = z.infer<typeof globalModelPricingPatchSchema>
