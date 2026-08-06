import { z } from 'zod'

export type SourceEntry = { model: string; category: string }

export type GeneratedEntry = {
  model: string
  category: string
  official: boolean
}

export type CatalogCategory = {
  category: string
  models: { model: string; official: boolean }[]
}

const modelIdRegex = /^[\w.-]+\/[\w.-]+$/

export const sourceEntrySchema = z
  .object({ model: z.string().regex(modelIdRegex), category: z.string().min(1) })
  .strict() satisfies z.ZodType<SourceEntry>

export const generatedEntrySchema = z
  .object({
    model: z.string().regex(modelIdRegex),
    category: z.string().min(1),
    official: z.boolean(),
  })
  .strict() satisfies z.ZodType<GeneratedEntry>

export const generatedFileSchema = z.array(generatedEntrySchema).min(1)

/**
 * Create-run bodies are inspected rather than forwarded verbatim, so they are parsed
 * here first. Unknown keys pass through untouched — the lane relays whatever inputs a
 * model takes — but `version` is read to enforce the whitelist, and the two webhook
 * fields are named so the route can strip the vendor's callback channel.
 */
export const createBodySchema = z.looseObject({
  version: z.string().optional(),
  webhook: z.unknown().optional(),
  webhook_events_filter: z.unknown().optional(),
})
