import { z } from 'zod'

/**
 * A connection's current model restrictions, determined by its provider. All
 * wording is the provider's: the pickers place it but never compose their own.
 */
export const modelAvailabilitySchema = z.object({
  /** Catalog models the connection cannot run right now, each with why ("Fable 5.1 isn't included in your Pro 30 plan."). */
  unavailable: z.array(z.object({ modelId: z.string(), reason: z.string() })),
  /** One sentence for the restriction as a whole ("Pro 30 excludes Claude Fable and GPT Astra."); null = nothing to add. */
  summary: z.string().nullable(),
  /** What a locked pick can do about it; null = nothing, the model is only unavailable. */
  action: z
    .object({
      /** Renderer action-registry key for the flow that resolves it (e.g. the plan upgrade dialog). */
      component: z.string(),
      /** Badge and button label ("Upgrade"). */
      label: z.string(),
      /** Where to send the user when the host cannot run the flow in place; null = nowhere. */
      href: z.string().nullable(),
    })
    .nullable(),
})

export type ModelAvailability = z.infer<typeof modelAvailabilitySchema>
export type ModelAvailabilityAction = NonNullable<ModelAvailability['action']>
