import { z } from 'zod'

export const ParallelRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

export const ParallelInitializeSchema = z.object({ protocolVersion: z.literal('2025-03-26') })
export const ParallelToolsSchema = z.object({ tools: z.array(z.object({ name: z.string() })) })
export const ParallelToolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})
export const ParallelSearchResponseSchema = z.object({
  results: z.array(z.object({
    url: z.httpUrl(),
    title: z.string().nullable().optional(),
    excerpts: z.array(z.string()),
    publish_date: z.string().nullable().optional(),
  })),
  warnings: z.array(z.object({ message: z.string() })).nullable().optional(),
})
