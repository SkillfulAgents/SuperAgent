import { z } from 'zod'

export const persistResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('wrote'), name: z.string(), updatedAt: z.string() }),
  z.object({ status: z.literal('deleted'), name: z.string() }),
])

export const curatorLookupSchema = z.object({
  agentSlug: z.string().nullable(),
})

export const pageReadResponseSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    name: z.string(),
    description: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    found: z.literal(false),
    suggestions: z.array(z.string()),
  }),
])
