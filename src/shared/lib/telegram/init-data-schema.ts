import { z } from 'zod'

export const initDataUserSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
})

export const initDataSchema = z.object({
  user: initDataUserSchema.optional(),
  // `.finite()` rejects a NaN auth_date (from a non-numeric value coerced via
  // Number(...)) so the downstream freshness check can't be silently bypassed.
  auth_date: z.number().finite(),
  query_id: z.string().optional(),
  hash: z.string(),
})

export type InitData = z.infer<typeof initDataSchema>
