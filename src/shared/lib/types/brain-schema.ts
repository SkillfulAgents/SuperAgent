import { z } from 'zod'
import { BRAIN_INDEX_FILENAME } from '@shared/lib/config/data-dir'

export const PAGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const PAGE_BODY_MAX_BYTES = 262_144

export function resolveBrainPageFilename(name: string): string | null {
  const trimmed = name.trim()
  const slug = trimmed.endsWith('.md') ? trimmed.slice(0, -3) : trimmed
  if (slug.toLowerCase() === 'index') return BRAIN_INDEX_FILENAME
  if (!PAGE_NAME_RE.test(slug)) return null
  return `${slug}.md`
}

/** First non-empty line of a page, hashes stripped. MCP read requires this field. */
export function pageDescription(body: string): string {
  const line = body.split('\n').find((row) => row.trim().length > 0) ?? ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 160)
}

export const pageReadSchema = z.object({
  name: z.string().min(1).max(80).refine((name) => resolveBrainPageFilename(name) !== null, 'invalid page name'),
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

export const brainWriteBodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  body: z.string().optional(),
  delete: z.boolean().optional(),
})

export const brainWriteResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('wrote'), name: z.string(), updatedAt: z.string() }),
  z.object({ status: z.literal('deleted'), name: z.string() }),
])

export const brainCuratorLookupSchema = z.object({
  agentSlug: z.string().nullable(),
})

export const curatorSlugSchema = z.object({
  agentSlug: z.string().min(1).nullable(),
})

export const curatorResponseSchema = z.object({
  enabled: z.boolean(),
  agentSlug: z.string().nullable(),
})

export type CuratorResponse = z.infer<typeof curatorResponseSchema>
