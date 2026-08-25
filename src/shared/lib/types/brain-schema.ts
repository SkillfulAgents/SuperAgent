import { z } from 'zod'

export const curatorSlugSchema = z.object({
  agentSlug: z.string().min(1).nullable(),
})

export const curatorResponseSchema = z.object({
  enabled: z.boolean(),
  agentSlug: z.string().nullable(),
})

export type CuratorResponse = z.infer<typeof curatorResponseSchema>
