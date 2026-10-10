import { z } from 'zod'

export const volumeStopResponseSchema = z.object({
  drained: z.boolean(),
  recovered: z.number().int().nonnegative(),
  recoveryErrors: z.number().int().nonnegative(),
})
