import { z } from 'zod'

/** A connection's current model restrictions, determined by its provider. */
export const modelAvailabilitySchema = z.object({
  unavailableModelIds: z.array(z.string()),
  restrictionName: z.string().nullable(),
  action: z.enum(['upgrade']).nullable(),
})

export type ModelAvailability = z.infer<typeof modelAvailabilitySchema>
