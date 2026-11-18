import { z } from 'zod'

/**
 * The slice of the API's agent and session listings that Spotlight indexes.
 * The cloud workspace can run an older version than this app, so everything
 * beyond identity is optional.
 */

export const spotlightAgentSchema = z.object({
  slug: z.string().min(1),
  name: z.string(),
  lastActivityAt: z.string().nullish(),
  sessionCount: z.number().optional(),
  dashboards: z.array(z.object({ slug: z.string().min(1), name: z.string() })).optional(),
})

export const spotlightSessionSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  lastActivityAt: z.string().nullish(),
})

export type SpotlightAgent = z.infer<typeof spotlightAgentSchema>
export type SpotlightSession = z.infer<typeof spotlightSessionSchema>

/**
 * The entries of a listing that parse. One malformed entry is dropped rather
 * than failing its whole Superagent on every pass; a body that is not a list
 * at all still throws.
 */
export function parseEach<T>(schema: z.ZodType<T>, value: unknown): T[] {
  return z.array(z.unknown()).parse(value).flatMap((entry) => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}
