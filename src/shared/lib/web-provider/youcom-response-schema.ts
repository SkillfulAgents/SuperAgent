import { z } from 'zod'

export const YouComRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

export const YouComInitializeSchema = z.object({ protocolVersion: z.string() })
export const YouComToolsSchema = z.object({ tools: z.array(z.object({ name: z.string() })) })
export const YouComToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})

const YouComWebHitSchema = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  snippets: z.array(z.string()).optional(),
  favicon_url: z.string().nullable().optional(),
  published_date: z.string().nullable().optional(),
})

export const YouComSearchResponseSchema = z.object({
  results: z.object({
    web: z.array(YouComWebHitSchema).optional(),
    news: z.array(YouComWebHitSchema).optional(),
  }).optional(),
})
