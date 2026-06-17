import { z } from 'zod'

export const initDataUserSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
})

export const initDataSchema = z.object({
  user: initDataUserSchema.optional(),
  auth_date: z.number(),
  query_id: z.string().optional(),
  hash: z.string(),
})

export type InitData = z.infer<typeof initDataSchema>
