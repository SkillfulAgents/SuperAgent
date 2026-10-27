import { z } from 'zod'

/** One platform account's cached plan policy, and when it goes stale (ms). */
export const platformPlanEntrySchema = z.object({
  policy: z.object({ planName: z.string().nullable(), deniedModels: z.array(z.string()) }).nullable(),
  expiresAt: z.number(),
})
